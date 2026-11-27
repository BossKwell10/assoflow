import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { dateSms, montantSms, PRIORITE, type CodeModele } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { FilesService } from '../../infra/files/files.js';
import { AuditService } from '../audit/audit.service.js';
import { MOIS_COURANT, NotificationsService, type ResultatPreparation } from './notifications.service.js';

export interface Diffusion {
  notifications: number;
  dejaEnvoyees: number;
  sansContact: number;
  unitesEstimees: number;
  quotaRestant: number;
}

export interface Envoi {
  membreId: string;
  code: CodeModele;
  variables: Record<string, string | number | null>;
  cleDedup: string;
  origineType: string;
  origineId?: string | null;
}

/** Nom court d'une association dans un SMS : sigle, sinon nom. */
export async function identiteAssociation(tx: Tx): Promise<{ nom: string; sigle: string }> {
  const r = await tx.query<{ nom: string; sigle: string | null }>(
    `SELECT nom, sigle FROM associations WHERE id = app_association_id()`,
  );
  const a = r.rows[0]!;
  return { nom: a.nom, sigle: a.sigle?.trim() || a.nom };
}

/**
 * Envois groupés aux membres (E6-04 rappels, A10 relances, E6-08 convocations) et alertes de quota (E6-05).
 * Chaque envoi est une ligne d'outbox dédoublonnée par `cle_dedup` ; les SMS partent après le commit.
 */
@Injectable()
export class DiffusionService implements OnModuleInit {
  private readonly logger = new Logger('Diffusion');

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.files.planifier({
      nom: 'rappels.generer',
      cron: '0 8 * * *',
      executer: () => this.pourToutes('rappels', (id) => this.genererRappels(id)),
    });
    this.files.planifier({
      nom: 'quotas.alerter',
      cron: '0 * * * *',
      executer: () => this.pourToutes('quotas', (id) => this.alerterQuota(id)),
    });
  }

  /** Exécute une tâche pour chaque association active, chacune dans sa transaction (une erreur n'arrête pas). */
  async pourToutes(nom: string, tache: (associationId: string) => Promise<unknown>): Promise<number> {
    const associations = await this.db.tx(
      async (tx) =>
        (await tx.query<{ id: string }>(`SELECT id FROM associations WHERE statut = 'active' ORDER BY id`))
          .rows,
      { requestId: `job-${nom}`, rolePlateforme: 'super_admin' },
    );
    for (const a of associations) {
      try {
        await tache(a.id);
      } catch (e) {
        this.logger.error(`${nom} : association ${a.id} en échec : ${(e as Error).message}`);
      }
    }
    return associations.length;
  }

  /** Crée les notifications dans la transaction courante ; renvoie le bilan et les lignes à publier. */
  async preparer(tx: Tx, envois: Envoi[]): Promise<{ diffusion: Diffusion; creees: ResultatPreparation[] }> {
    const quotaRestant = await this.notifications.quotaRestant(tx);
    const diffusion: Diffusion = {
      notifications: 0,
      dejaEnvoyees: 0,
      sansContact: 0,
      unitesEstimees: 0,
      quotaRestant,
    };
    const creees: ResultatPreparation[] = [];
    for (const e of envois) {
      const r = await this.notifications.preparer(tx, {
        code: e.code,
        membreId: e.membreId,
        variables: e.variables,
        cleDedup: e.cleDedup,
        origineType: e.origineType,
        origineId: e.origineId ?? null,
      });
      if (r.type === 'creee') {
        diffusion.notifications++;
        diffusion.unitesEstimees += r.unites;
        creees.push(r);
      } else if (r.type === 'deja') diffusion.dejaEnvoyees++;
      else diffusion.sansContact++;
    }
    return { diffusion, creees };
  }

  /**
   * RG-COT-050 (E6-04) : rappels J-7, J-1 (rappel_avant) et J+7 (rappel_retard) des échéances non soldées.
   * Un seul message par membre et par jour, montants regroupés ; membres suspendus, désactivés ou
   * `canal_prefere = aucun` exclus (le relais par le chef de famille s'applique aux membres sans téléphone).
   */
  async genererRappels(associationId: string): Promise<Diffusion> {
    const contexte = { requestId: `job-rappels-${associationId}`, associationId };
    const { diffusion, creees } = await this.db.tx(async (tx) => {
      const r = await tx.query<{ membre_id: string; date_echeance: string; reste: string; jour: string }>(
        `SELECT e.membre_id, e.date_echeance, (e.montant_du - e.montant_paye)::bigint AS reste,
                current_date::text AS jour
           FROM v_echeances_situation e
           JOIN membres m ON m.id = e.membre_id
          WHERE NOT e.exoneree AND e.montant_du > e.montant_paye
            AND e.date_echeance IN (current_date + 7, current_date + 1, current_date - 7)
            AND m.etat = 'actif' AND m.canal_prefere <> 'aucun'
            AND m.deleted_at IS NULL AND m.anonymise_at IS NULL
          ORDER BY e.membre_id, e.date_echeance`,
      );
      const association = await identiteAssociation(tx);
      const envois = this.regrouper(r.rows, (membreId, retard, total, date, jour) => ({
        membreId,
        code: retard ? 'rappel_retard' : 'rappel_avant',
        variables: {
          'association.sigle': association.sigle,
          montant: montantSms(total),
          date: dateSms(date),
        },
        cleDedup: `rappel:${membreId}:${jour}`,
        origineType: 'rappel',
      }));
      return this.preparer(tx, envois);
    }, contexte);
    await this.notifications.publier(creees);
    if (diffusion.notifications > 0) {
      this.logger.log(`Rappels de l'association ${associationId} : ${diffusion.notifications} SMS`);
    }
    return diffusion;
  }

  /**
   * Relance manuelle (écran A10) : `rappel_retard` aux membres des échéances choisies qui sont en retard, montants
   * regroupés par membre ; au plus une relance manuelle par membre et par jour.
   */
  async relancer(auth: AuthRequete, echeanceIds: string[]): Promise<Diffusion> {
    const { diffusion, creees } = await this.db.tx(async (tx) => {
      const r = await tx.query<{ membre_id: string; date_echeance: string; reste: string; jour: string }>(
        `SELECT e.membre_id, e.date_echeance, (e.montant_du - e.montant_paye)::bigint AS reste,
                current_date::text AS jour
           FROM v_echeances_situation e
           JOIN membres m ON m.id = e.membre_id
          WHERE e.id = ANY($1::uuid[]) AND e.situation = 'en_retard'
            AND m.etat = 'actif' AND m.deleted_at IS NULL AND m.anonymise_at IS NULL
          ORDER BY e.membre_id, e.date_echeance`,
        [[...new Set(echeanceIds)]],
      );
      const association = await identiteAssociation(tx);
      const envois = this.regrouper(r.rows, (membreId, _retard, total, date, jour) => ({
        membreId,
        code: 'rappel_retard',
        variables: {
          'association.sigle': association.sigle,
          montant: montantSms(total),
          date: dateSms(date),
        },
        cleDedup: `relance:${membreId}:${jour}`,
        origineType: 'relance',
      }));
      const resultat = await this.preparer(tx, envois);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'echeances.relancees',
        entiteType: 'notification',
        apres: { echeances: echeanceIds.length, ...resultat.diffusion },
      });
      return resultat;
    });
    await this.notifications.publier(creees);
    return diffusion;
  }

  private regrouper(
    lignes: { membre_id: string; date_echeance: string; reste: string; jour: string }[],
    creer: (membreId: string, retard: boolean, total: number, date: string, jour: string) => Envoi,
  ): Envoi[] {
    const parMembre = new Map<string, typeof lignes>();
    for (const l of lignes) parMembre.set(l.membre_id, [...(parMembre.get(l.membre_id) ?? []), l]);
    return [...parMembre].map(([membreId, ls]) => {
      const jour = ls[0]!.jour;
      const retards = ls.filter((l) => l.date_echeance < jour);
      const reference = (retards.length > 0 ? retards : ls)[0]!.date_echeance;
      const total = ls.reduce((s, l) => s + Number(l.reste), 0);
      return creer(membreId, retards.length > 0, total, reference, jour);
    });
  }

  /**
   * RF-SUP-031 (E6-05) : alerte aux présidents à 80 % puis 100 % du quota mensuel, une fois par seuil et par mois.
   * L'alerte est prioritaire (elle part même quota atteint).
   */
  async alerterQuota(associationId: string): Promise<number | null> {
    const contexte = { requestId: `job-quotas-${associationId}`, associationId };
    const creees = await this.db.tx(async (tx) => {
      const r = await tx.query<{
        quota: number;
        unites: number;
        mois: string;
        alerte_80_at: Date | null;
        alerte_100_at: Date | null;
      }>(
        `SELECT a.quota_sms_mensuel AS quota, c.unites, c.mois::text AS mois, c.alerte_80_at, c.alerte_100_at
           FROM associations a
           JOIN consommation_sms c ON c.association_id = a.id AND c.mois = ${MOIS_COURANT}
          WHERE a.id = app_association_id()
          FOR UPDATE OF c`,
      );
      const c = r.rows[0];
      if (!c || c.quota <= 0) return [];
      const pct = (c.unites * 100) / c.quota;
      const seuil = pct >= 100 && !c.alerte_100_at ? 100 : pct >= 80 && !c.alerte_80_at ? 80 : null;
      if (!seuil) return [];
      const presidents = await tx.query<{ user_id: string }>(
        `SELECT DISTINCT a.user_id FROM acces_association a JOIN roles r ON r.id = a.role_id
          WHERE r.code = 'president' AND a.statut = 'actif'`,
      );
      const association = await identiteAssociation(tx);
      const resultats: ResultatPreparation[] = [];
      for (const p of presidents.rows) {
        resultats.push(
          await this.notifications.preparer(tx, {
            code: 'quota_sms',
            userId: p.user_id,
            variables: { pourcentage: Math.min(Math.floor(pct), 999), 'association.nom': association.nom },
            cleDedup: `quota:${c.mois}:${seuil}:${p.user_id}`,
            origineType: 'quota',
            priorite: PRIORITE.prioritaire,
          }),
        );
      }
      // Le seuil de 100 % vaut aussi pour 80 % (pas de seconde alerte en retard).
      await tx.query(
        `UPDATE consommation_sms SET alerte_80_at = coalesce(alerte_80_at, now()),
                alerte_100_at = CASE WHEN $1 = 100 THEN now() ELSE alerte_100_at END
          WHERE association_id = app_association_id() AND mois = $2::date`,
        [seuil, c.mois],
      );
      await this.audit.tracer(tx, {
        associationId,
        acteurId: null,
        acteurType: 'systeme',
        action: 'sms.quota_alerte',
        entiteType: 'association',
        entiteId: associationId,
        apres: { seuil, unites: c.unites, quota: c.quota, mois: c.mois },
      });
      return resultats;
    }, contexte);
    await this.notifications.publier(creees);
    return creees.length > 0 ? creees.length : null;
  }
}

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  masquerTelephone,
  MODELES_NOTIFICATION,
  PRIORITE,
  rendreModele,
  unitesSms,
  type CodeModele,
  type StatutNotification,
} from '@assoflow/contracts';
import { contexteStorage } from '../../common/contexte.js';
import { decoderCurseur, encoderCurseur } from '../../common/pagination.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { FilesService } from '../../infra/files/files.js';
import { ErreurFournisseurSms, FOURNISSEUR_SMS } from '../../infra/sms/fournisseur-sms.js';
import type { RouteurSms } from '../../infra/sms/routeur-sms.js';

/** Essais d'envoi avant échec définitif (docs/06 §2). */
export const TENTATIVES_MAX = 5;

export interface DemandeNotification {
  code: CodeModele;
  /** Destinataire membre : son téléphone, ou celui de son chef de famille (RF-060, RG-MBR-002). */
  membreId?: string | null;
  /** Destinataire utilisateur (bureau) : téléphone du compte. */
  userId?: string | null;
  variables: Record<string, string | number | null | undefined>;
  origineType?: string | null;
  origineId?: string | null;
  /** Clé de dédoublonnage (`recu:<id>`, `rappel:<membre>:<jour>`…) ; `null` = toujours un nouvel envoi. */
  cleDedup?: string | null;
  /** Priorité imposée (sinon celle du modèle). */
  priorite?: number;
  /** Respecter `canal_prefere = aucun` (par défaut oui). */
  respecterRefus?: boolean;
}

export type ResultatPreparation =
  | {
      type: 'creee';
      id: string;
      associationId: string;
      priorite: number;
      statut: StatutNotification;
      destinataireMasque: string;
      relaisFamille: boolean;
      unites: number;
    }
  | { type: 'deja'; id: string }
  | { type: 'sans_contact' };

export interface LigneNotification {
  id: string;
  association_id: string;
  membre_id: string | null;
  membre_nom: string | null;
  canal: string;
  modele_code: string;
  destinataire: string;
  contenu: string;
  priorite: number;
  origine_type: string | null;
  origine_id: string | null;
  statut: StatutNotification;
  fournisseur: string | null;
  tentatives: number;
  derniere_erreur: string | null;
  unites: number;
  relais_famille: boolean;
  envoyee_at: Date | null;
  remise_at: Date | null;
  created_at: Date;
}

export function versDtoNotification(l: LigneNotification) {
  return {
    id: l.id,
    canal: l.canal,
    modeleCode: l.modele_code,
    destinataireMasque: l.canal === 'sms' ? masquerTelephone(l.destinataire) : '•••',
    statut: l.statut,
    fournisseur: l.fournisseur,
    unites: l.unites,
    createdAt: l.created_at.toISOString(),
    remiseAt: l.remise_at?.toISOString() ?? null,
    membreId: l.membre_id,
    membreNom: l.membre_nom,
    relaisFamille: l.relais_famille,
    priorite: l.priorite,
    origineType: l.origine_type,
    origineId: l.origine_id,
    contenu: l.contenu,
    tentatives: l.tentatives,
    derniereErreur: l.derniere_erreur,
    envoyeeAt: l.envoyee_at?.toISOString() ?? null,
  };
}

const SELECT_NOTIFICATION = `
  SELECT n.created_at::text AS ts, n.id, n.association_id, n.membre_id,
         CASE WHEN m.id IS NULL THEN NULL ELSE trim(m.prenoms || ' ' || m.nom) END AS membre_nom,
         n.canal, n.modele_code, n.destinataire, n.contenu, n.priorite, n.origine_type, n.origine_id, n.statut,
         n.fournisseur, n.tentatives, n.derniere_erreur, n.unites, n.relais_famille, n.envoyee_at, n.remise_at,
         n.created_at
    FROM notifications n LEFT JOIN membres m ON m.id = n.membre_id`;

/** Premier jour du mois courant (GMT, docs/06 §4.3). */
export const MOIS_COURANT = `date_trunc('month', now() AT TIME ZONE 'UTC')::date`;

/**
 * Outbox des notifications (docs/06 §1, E6-01) : la ligne est insérée dans la transaction métier (`preparer`),
 * puis mise en file après le commit (`publier`). Le worker (`envoyer`) réserve la ligne, contrôle le quota,
 * appelle le routeur SMS hors transaction, puis enregistre le résultat. Rejouable : une notification déjà
 * envoyée n'est jamais renvoyée par la reprise ; un renvoi volontaire est une nouvelle ligne.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    @Inject(FOURNISSEUR_SMS) private readonly sms: RouteurSms,
  ) {}

  onModuleInit(): void {
    const traitement = async (_nom: string, d: Record<string, unknown>) => {
      await this.envoyer(String(d.notificationId), String(d.associationId));
    };
    this.files.traiter('notifications-prioritaires', traitement);
    this.files.traiter('notifications', traitement);
    this.files.planifier({
      nom: 'notifications.reprise',
      cron: '* * * * *',
      executer: () => this.reprendre(),
    });
  }

  /** Texte du modèle : personnalisé par l'association, sinon global en base, sinon défaut du code. */
  async modele(tx: Tx, code: CodeModele): Promise<string> {
    const r = await tx.query<{ contenu: string }>(
      `SELECT contenu FROM modeles_notification
        WHERE code = $1 AND canal = 'sms' AND langue = 'fr' AND actif
          AND (association_id = app_association_id() OR association_id IS NULL)
        ORDER BY association_id NULLS LAST LIMIT 1`,
      [code],
    );
    return r.rows[0]?.contenu ?? MODELES_NOTIFICATION[code].contenu;
  }

  /**
   * Destinataire SMS d'un membre (RF-060) : son téléphone, sinon celui du chef de sa famille. Aucun destinataire
   * pour une fiche désactivée, anonymisée, supprimée, ou qui refuse les messages (`canal_prefere = aucun`).
   */
  async destinataireMembre(
    tx: Tx,
    membreId: string,
    respecterRefus = true,
  ): Promise<{ telephone: string; relaisFamille: boolean } | null> {
    const r = await tx.query<{
      telephone: string | null;
      canal_prefere: string;
      etat: string;
      inactif: boolean;
      tel_chef: string | null;
    }>(
      `SELECT m.telephone, m.canal_prefere, m.etat,
              (m.deleted_at IS NOT NULL OR m.anonymise_at IS NOT NULL) AS inactif,
              (SELECT c.telephone FROM familles f JOIN membres c ON c.id = f.chef_famille_id
                WHERE f.id = m.famille_id AND c.deleted_at IS NULL AND c.anonymise_at IS NULL
                  AND c.etat <> 'desactive') AS tel_chef
         FROM membres m WHERE m.id = $1`,
      [membreId],
    );
    const m = r.rows[0];
    if (!m || m.inactif || m.etat === 'desactive') return null;
    if (respecterRefus && m.canal_prefere === 'aucun') return null;
    if (m.telephone) return { telephone: m.telephone, relaisFamille: false };
    if (m.tel_chef) return { telephone: m.tel_chef, relaisFamille: true };
    return null;
  }

  /** Insère la notification dans la transaction courante (outbox). À publier après le commit. */
  async preparer(tx: Tx, d: DemandeNotification): Promise<ResultatPreparation> {
    let destinataire: { telephone: string; relaisFamille: boolean } | null = null;
    if (d.membreId) destinataire = await this.destinataireMembre(tx, d.membreId, d.respecterRefus ?? true);
    else if (d.userId) {
      const u = await tx.query<{ telephone: string }>(`SELECT telephone FROM users WHERE id = $1`, [
        d.userId,
      ]);
      if (u.rows[0]) destinataire = { telephone: u.rows[0].telephone, relaisFamille: false };
    }
    if (!destinataire) return { type: 'sans_contact' };
    const contenu = rendreModele(await this.modele(tx, d.code), d.variables);
    const priorite = d.priorite ?? MODELES_NOTIFICATION[d.code].priorite;
    const unites = unitesSms(contenu);
    const r = await tx.query<{ id: string; association_id: string }>(
      `INSERT INTO notifications (association_id, membre_id, user_id, canal, modele_code, destinataire, contenu,
                                  priorite, origine_type, origine_id, cle_dedup, relais_famille, unites)
       VALUES (app_association_id(), $1, $2, 'sms', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (association_id, cle_dedup) WHERE cle_dedup IS NOT NULL DO NOTHING
       RETURNING id, association_id`,
      [
        d.membreId ?? null,
        d.userId ?? null,
        d.code,
        destinataire.telephone,
        contenu,
        priorite,
        d.origineType ?? null,
        d.origineId ?? null,
        d.cleDedup ?? null,
        destinataire.relaisFamille,
        unites,
      ],
    );
    if (!r.rows[0]) {
      const existante = await tx.query<{ id: string }>(
        `SELECT id FROM notifications WHERE association_id = app_association_id() AND cle_dedup = $1`,
        [d.cleDedup],
      );
      return { type: 'deja', id: existante.rows[0]!.id };
    }
    return {
      type: 'creee',
      id: r.rows[0].id,
      associationId: r.rows[0].association_id,
      priorite,
      statut: 'en_attente',
      destinataireMasque: masquerTelephone(destinataire.telephone),
      relaisFamille: destinataire.relaisFamille,
      unites,
    };
  }

  /** Met en file les notifications créées (à appeler après le commit, docs/06 §1). Ne lève jamais. */
  async publier(notifications: (ResultatPreparation | null | undefined)[]): Promise<void> {
    for (const n of notifications) {
      if (n?.type !== 'creee') continue;
      await this.mettreEnFile(n.id, n.associationId, n.priorite, 0);
    }
  }

  private async mettreEnFile(id: string, associationId: string, priorite: number, essai: number) {
    try {
      await this.files.ajouter(
        priorite <= PRIORITE.prioritaire ? 'notifications-prioritaires' : 'notifications',
        'notifications.envoyer',
        { notificationId: id, associationId },
        `notification-${id}-${essai}`,
      );
    } catch (e) {
      // La reprise (toutes les minutes) rattrapera la ligne restée en attente.
      this.logger.error(`Mise en file de la notification ${id} impossible : ${(e as Error).message}`);
    }
  }

  /**
   * Envoi d'une notification (worker). Une erreur transitoire avant le dernier essai est relancée (nouvel essai
   * BullMQ) ; au-delà, ou pour une erreur définitive, statut `echec`.
   */
  async envoyer(notificationId: string, associationId: string): Promise<StatutNotification | null> {
    const contexte = { requestId: `notification-${notificationId}`, associationId };
    return contexteStorage.run(contexte, async () => {
      const ligne = await this.db.tx(async (tx) => {
        const r = await tx.query<{
          id: string;
          destinataire: string;
          contenu: string;
          priorite: number;
          unites: number;
          tentatives: number;
        }>(
          `UPDATE notifications SET traitement_at = now(), tentatives = tentatives + 1
            WHERE id = $1 AND statut = 'en_attente'
              AND (traitement_at IS NULL OR traitement_at < now() - interval '5 minutes')
           RETURNING id, destinataire, contenu, priorite, unites, tentatives`,
          [notificationId],
        );
        const n = r.rows[0];
        if (!n) return null;
        // Quota (docs/06 §4.3) : OTP et reçus (priorité 1) ne sont jamais bloqués, mais comptés.
        if (n.priorite > PRIORITE.prioritaire) {
          const q = await tx.query<{ quota: number; unites: number }>(
            `SELECT a.quota_sms_mensuel AS quota, coalesce(c.unites, 0) AS unites
               FROM associations a
               LEFT JOIN consommation_sms c ON c.association_id = a.id AND c.mois = ${MOIS_COURANT}
              WHERE a.id = app_association_id()`,
          );
          if (q.rows[0] && q.rows[0].unites >= q.rows[0].quota) {
            await tx.query(
              `UPDATE notifications SET statut = 'hors_quota', traitement_at = NULL,
                      derniere_erreur = 'Quota SMS mensuel atteint' WHERE id = $1`,
              [n.id],
            );
            return { ...n, horsQuota: true };
          }
        }
        return { ...n, horsQuota: false };
      }, contexte);
      if (!ligne) return null;
      if (ligne.horsQuota) return 'hors_quota';
      try {
        const r = await this.sms.router({ to: ligne.destinataire, texte: ligne.contenu, ref: ligne.id });
        await this.db.tx(async (tx) => {
          await tx.query(
            `UPDATE notifications SET statut = 'envoyee', fournisseur = $2, fournisseur_msg_id = $3, unites = $4,
                    envoyee_at = now(), traitement_at = NULL, derniere_erreur = NULL
              WHERE id = $1`,
            [ligne.id, r.fournisseur, r.idFournisseur, r.unites],
          );
          await tx.query(
            `INSERT INTO consommation_sms (association_id, mois, unites)
             VALUES (app_association_id(), ${MOIS_COURANT}, $1)
             ON CONFLICT (association_id, mois) DO UPDATE SET unites = consommation_sms.unites + EXCLUDED.unites`,
            [r.unites],
          );
        }, contexte);
        return 'envoyee';
      } catch (e) {
        const transitoire = e instanceof ErreurFournisseurSms ? e.transitoire : true;
        const definitif = !transitoire || ligne.tentatives >= TENTATIVES_MAX;
        await this.db.tx(
          (tx) =>
            tx.query(
              `UPDATE notifications SET statut = $2, derniere_erreur = $3, traitement_at = NULL WHERE id = $1`,
              [ligne.id, definitif ? 'echec' : 'en_attente', (e as Error).message.slice(0, 500)],
            ),
          contexte,
        );
        if (definitif) {
          this.logger.error(`Notification ${ligne.id} en échec définitif : ${(e as Error).message}`);
          return 'echec';
        }
        throw e; // nouvel essai par la file
      }
    });
  }

  /** Reprise (toutes les minutes) : lignes en attente depuis plus de 2 min sans traitement en cours. */
  async reprendre(): Promise<number> {
    const associations = await this.db.tx(
      async (tx) =>
        (await tx.query<{ id: string }>(`SELECT id FROM associations WHERE statut <> 'archivee' ORDER BY id`))
          .rows,
      { requestId: 'job-notifications-reprise', rolePlateforme: 'super_admin' },
    );
    let total = 0;
    for (const a of associations) {
      const lignes = await this.db.tx(
        async (tx) =>
          (
            await tx.query<{ id: string; priorite: number; tentatives: number }>(
              `SELECT id, priorite, tentatives FROM notifications
                WHERE statut = 'en_attente' AND created_at < now() - interval '2 minutes'
                  AND (traitement_at IS NULL OR traitement_at < now() - interval '5 minutes')
                  AND tentatives < $1
                ORDER BY priorite, created_at LIMIT 500`,
              [TENTATIVES_MAX],
            )
          ).rows,
        { requestId: 'job-notifications-reprise', associationId: a.id },
      );
      for (const l of lignes) await this.mettreEnFile(l.id, a.id, l.priorite, l.tentatives);
      total += lignes.length;
    }
    if (total > 0) this.logger.warn(`Reprise : ${total} notification(s) remise(s) en file`);
    return total;
  }

  async lire(tx: Tx, id: string) {
    const r = await tx.query<LigneNotification>(`${SELECT_NOTIFICATION} WHERE n.id = $1`, [id]);
    return r.rows[0] ? versDtoNotification(r.rows[0]) : null;
  }

  /** Historique des envois (écran A22), plus récents d'abord. */
  lister(f: {
    membreId?: string;
    statut?: string;
    canal?: string;
    modele?: string;
    limite: number;
    curseur?: string;
  }) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conditions = ['true'];
    if (f.membreId) conditions.push(`n.membre_id = ${p(f.membreId)}`);
    if (f.statut) conditions.push(`n.statut = ${p(f.statut)}`);
    if (f.canal) conditions.push(`n.canal = ${p(f.canal)}`);
    if (f.modele) conditions.push(`n.modele_code = ${p(f.modele)}`);
    const position = decoderCurseur(f.curseur);
    if (position) {
      conditions.push(`(n.created_at, n.id) < (${p(position.ts)}::timestamptz, ${p(position.id)}::uuid)`);
    }
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneNotification & { ts: string }>(
        `${SELECT_NOTIFICATION} WHERE ${conditions.join(' AND ')}
          ORDER BY n.created_at DESC, n.id DESC LIMIT ${p(f.limite + 1)}`,
        params,
      );
      const lignes = r.rows.slice(0, f.limite);
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map(versDtoNotification),
        page: {
          curseurSuivant: derniere ? encoderCurseur({ ts: derniere.ts, id: derniere.id }) : null,
          total: null,
        },
      };
    });
  }

  /** Consommation SMS du mois (RF-SUP-031). */
  consommation() {
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ mois: string; quota: number; unites: number; hors_quota: number }>(
        `SELECT ${MOIS_COURANT}::text AS mois, a.quota_sms_mensuel AS quota, coalesce(c.unites, 0) AS unites,
                (SELECT count(*)::int FROM notifications n
                  WHERE n.statut = 'hors_quota' AND n.created_at >= ${MOIS_COURANT}) AS hors_quota
           FROM associations a
           LEFT JOIN consommation_sms c ON c.association_id = a.id AND c.mois = ${MOIS_COURANT}
          WHERE a.id = app_association_id()`,
      );
      const parModele = await tx.query<{ modele_code: string; unites: string }>(
        `SELECT modele_code, sum(unites)::bigint AS unites FROM notifications
          WHERE envoyee_at >= ${MOIS_COURANT} AND canal = 'sms' GROUP BY modele_code ORDER BY modele_code`,
      );
      const c = r.rows[0]!;
      return {
        mois: c.mois,
        quota: c.quota,
        unites: c.unites,
        pourcentage: c.quota > 0 ? Math.round((c.unites * 100) / c.quota) : 100,
        horsQuota: c.hors_quota,
        parModele: Object.fromEntries(parModele.rows.map((x) => [x.modele_code, Number(x.unites)])),
      };
    });
  }

  /** Unités restantes du mois (négatif = dépassement), dans la transaction courante. */
  async quotaRestant(tx: Tx): Promise<number> {
    const r = await tx.query<{ reste: number }>(
      `SELECT a.quota_sms_mensuel - coalesce(c.unites, 0) AS reste
         FROM associations a
         LEFT JOIN consommation_sms c ON c.association_id = a.id AND c.mois = ${MOIS_COURANT}
        WHERE a.id = app_association_id()`,
    );
    return r.rows[0]?.reste ?? 0;
  }

  /** Accusé de remise reçu par webhook (hors tenant) : nombre de notifications mises à jour. */
  async accuser(fournisseur: string, idFournisseur: string, statut: 'remise' | 'echec', at?: Date) {
    return this.db.tx(
      async (tx) => {
        const r = await tx.query<{ n: number }>(`SELECT app_accuse_sms($1, $2, $3, $4) AS n`, [
          fournisseur,
          idFournisseur,
          statut,
          at ?? null,
        ]);
        return r.rows[0]?.n ?? 0;
      },
      { requestId: `webhook-sms-${fournisseur}` },
    );
  }
}

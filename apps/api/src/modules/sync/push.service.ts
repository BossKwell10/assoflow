import { Injectable, Logger } from '@nestjs/common';
import {
  ayantDroitMajSchema,
  ayantDroitSchema,
  CODES_REJET,
  familleMajSchema,
  familleSchema,
  membreCreationSchema,
  membreMajSchema,
  paiementCreationSchema,
  pieceJointeSchema,
  TABLES_PUSH,
  type CodeRejet,
  type Permission,
  type SyncPush,
  type TablePush,
} from '@assoflow/contracts';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { empreinte, referenceInvalide } from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { valider } from '../../common/validation.js';
import { DatabaseService } from '../../infra/database.js';
import { AyantsDroitService } from '../membres/ayants-droit.service.js';
import { FamillesService } from '../membres/familles.service.js';
import { MembresService } from '../membres/membres.service.js';
import { PaiementsService } from '../paiements/paiements.service.js';
import { AppareilsService, type LigneAppareil } from './appareils.service.js';
import { PiecesJointesService } from './pieces-jointes.service.js';
import { PullService } from './pull.service.js';

export interface ResultatElement {
  table: TablePush;
  id: string;
  statut: 'accepte' | 'deja_recu' | 'rejete';
  code?: string | null;
  message?: string | null;
  serveur?: Record<string, unknown>;
}

type Ligne = Record<string, unknown>;
type Operation = 'created' | 'updated' | 'deleted';

/** Rejet métier d'un élément (enregistré et renvoyé à l'appareil jusqu'à acquittement). */
class Rejet extends Error {
  constructor(
    readonly code: CodeRejet,
    message: string,
  ) {
    super(message);
  }
}

/** Champs de l'appareil (snake_case) → champs de l'API (camelCase), par table. */
const CHAMPS = {
  familles: { nom: 'nom', chef_famille_id: 'chefFamilleId', village_origine: 'villageOrigine' },
  membres: {
    nom: 'nom',
    prenoms: 'prenoms',
    sexe: 'sexe',
    date_naissance: 'dateNaissance',
    telephone: 'telephone',
    telephone_whatsapp: 'telephoneWhatsapp',
    email: 'email',
    village_origine: 'villageOrigine',
    lieu_residence: 'lieuResidence',
    pays_residence: 'paysResidence',
    categorie_id: 'categorieId',
    famille_id: 'familleId',
    canal_prefere: 'canalPrefere',
    notes: 'notes',
    date_adhesion: 'dateAdhesion',
  },
  ayants_droit: { nom: 'nom', prenoms: 'prenoms', lien: 'lien', date_naissance: 'dateNaissance' },
} as const;

/** Colonnes de type `date` transmises en millisecondes epoch par WatermelonDB. */
const DATES = new Set(['date_naissance', 'date_adhesion']);

/** Références à d'autres éléments du lot (dépendance rejetée, docs/05 §5.1). */
const REFERENCES = ['famille_id', 'chef_famille_id', 'membre_id', 'entite_id', 'reunion_id'];

function valeur(champ: string, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (DATES.has(champ) && typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  if (v === '') return null;
  return v;
}

/** Sélection des champs : tous (création) ou ceux listés dans `_changed` (modification, last-write-wins par champ). */
function versApi(
  table: keyof typeof CHAMPS,
  ligne: Ligne,
  seulementModifies: boolean,
): Record<string, unknown> {
  const modifies = seulementModifies
    ? new Set(
        String(ligne._changed ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      )
    : null;
  const sortie: Record<string, unknown> = {};
  for (const [colonne, champ] of Object.entries(CHAMPS[table])) {
    if (modifies && !modifies.has(colonne)) continue;
    const v = valeur(colonne, ligne[colonne]);
    if (v !== undefined) sortie[champ] = v;
  }
  return sortie;
}

function horodatage(v: unknown): string | undefined {
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') return v;
  return undefined;
}

/**
 * Push (E5-03, E5-04, docs/05 §5-6) : tables dans l'ordre `familles → … → presences`, chaque élément dans sa propre
 * transaction (un rejet n'interrompt pas le lot) avec un résultat `accepte`, `deja_recu` ou `rejete`. Les écritures
 * réutilisent les services de la console (mêmes règles, même audit). Un rejet est enregistré pour l'appareil.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger('SyncPush');

  constructor(
    private readonly db: DatabaseService,
    private readonly appareils: AppareilsService,
    private readonly pull: PullService,
    private readonly membres: MembresService,
    private readonly familles: FamillesService,
    private readonly ayantsDroit: AyantsDroitService,
    private readonly paiements: PaiementsService,
    private readonly pieces: PiecesJointesService,
  ) {}

  async pousser(auth: AuthRequete, p: SyncPush) {
    this.pull.verifierVersions(p.versionApp, p.versionSchema);
    const { appareil, statut } = await this.db.tx(async (tx) => ({
      appareil: await this.appareils.courant(tx, auth),
      statut: (
        await tx.query<{ statut: string }>(`SELECT statut FROM associations WHERE id = app_association_id()`)
      ).rows[0]!.statut,
    }));
    // RG-ASS-004 : tenant suspendu en lecture seule (le pull reste permis).
    if (statut !== 'active') {
      throw new ErreurMetier('TENANT_SUSPENDU', 'Association suspendue : synchronisation en lecture seule');
    }
    const resultats: ResultatElement[] = [];
    const rejetes = new Set<string>();
    for (const table of TABLES_PUSH) {
      const t = p.changes[table];
      if (!t) continue;
      const operations: [Operation, Ligne][] = [
        ...(t.created ?? []).map((l): [Operation, Ligne] => ['created', l]),
        ...(t.updated ?? []).map((l): [Operation, Ligne] => ['updated', l]),
        ...(t.deleted ?? []).map((id): [Operation, Ligne] => ['deleted', { id }]),
      ];
      for (const [operation, ligne] of operations) {
        const r = await this.traiter(auth, appareil, table, operation, ligne, rejetes);
        if (r.statut === 'rejete') rejetes.add(r.id);
        resultats.push(r);
      }
    }
    const curseur = await this.db.tx(async (tx) => {
      await tx.query(`UPDATE appareils SET derniere_sync = now() WHERE id = $1`, [appareil.id]);
      return Number(
        (
          await tx.query<{ c: string }>(
            `SELECT sync_counter AS c FROM associations WHERE id = app_association_id()`,
          )
        ).rows[0]!.c,
      );
    });
    return { resultats, curseur };
  }

  private async traiter(
    auth: AuthRequete,
    appareil: LigneAppareil,
    table: TablePush,
    operation: Operation,
    ligne: Ligne,
    rejetes: Set<string>,
  ): Promise<ResultatElement> {
    const id = String(ligne.id);
    const emp = empreinte({ operation, ...ligne });
    try {
      if (!z.uuid().safeParse(id).success) throw new Rejet('VALIDATION', 'Identifiant UUID attendu');
      // docs/05 §5.3 : un élément créé déjà rejeté reçoit le même rejet.
      if (operation === 'created') {
        const deja = await this.rejetExistant(appareil.id, table, id);
        if (deja) return { table, id, statut: 'rejete', code: deja.code, message: deja.message };
      }
      const dependance = REFERENCES.find(
        (c) => typeof ligne[c] === 'string' && rejetes.has(ligne[c] as string),
      );
      if (dependance) {
        throw new Rejet('DEPENDANCE_REJETEE', `Élément référencé (${dependance}) rejeté dans ce lot`);
      }
      const r = await this.appliquer(auth, appareil, table, operation, ligne);
      return { table, id, statut: r.cree === false ? 'deja_recu' : 'accepte', serveur: r.serveur ?? {} };
    } catch (e) {
      const rejet = this.versRejet(e);
      if (!rejet) {
        // Erreur inattendue : non enregistrée (l'appareil renverra l'élément au prochain push).
        this.logger.error(`Push ${table}/${id} : ${(e as Error).stack}`);
        return {
          table,
          id,
          statut: 'rejete',
          code: 'ERREUR_INTERNE',
          message: 'Erreur interne : réessayez plus tard',
        };
      }
      await this.enregistrerRejet(appareil.id, table, id, rejet, emp);
      return { table, id, statut: 'rejete', code: rejet.code, message: rejet.message };
    }
  }

  private exiger(auth: AuthRequete, permission: Permission): void {
    if (!auth.permissions.includes(permission)) {
      throw new Rejet('PERMISSION_REFUSEE', `Permission requise : ${permission}`);
    }
  }

  private async appliquer(
    auth: AuthRequete,
    appareil: LigneAppareil,
    table: TablePush,
    operation: Operation,
    ligne: Ligne,
  ): Promise<{ cree?: boolean; serveur?: Record<string, unknown> }> {
    const id = String(ligne.id);
    switch (table) {
      case 'familles': {
        if (operation === 'deleted')
          throw new Rejet('OPERATION_INTERDITE', 'Suppression de famille non permise');
        if (operation === 'created') {
          this.exiger(auth, 'membre.creer');
          const r = await this.familles.creer(
            auth,
            valider(familleSchema, { id, ...versApi('familles', ligne, false) }),
          );
          return { cree: r.cree };
        }
        this.exiger(auth, 'membre.modifier');
        await this.familles.modifier(auth, id, valider(familleMajSchema, versApi('familles', ligne, true)));
        return {};
      }
      case 'membres': {
        if (operation === 'deleted') {
          throw new Rejet(
            'OPERATION_INTERDITE',
            'Suppression de membre non permise (désactivation dans la console)',
          );
        }
        if (operation === 'created') {
          this.exiger(auth, 'membre.creer');
          if (ligne.consentement_traitement !== true) {
            throw new Rejet(
              'VALIDATION',
              'Consentement au traitement des données obligatoire (consentement_traitement)',
            );
          }
          // Doublon probable : accepté et marqué « à vérifier » pour la console (docs/05 §5.2).
          const r = await this.membres.creer(
            auth,
            valider(membreCreationSchema, {
              id,
              ...versApi('membres', ligne, false),
              consentement: { traitementDonnees: true, canal: 'mobile' },
              confirmationDoublon: true,
            }),
          );
          return { cree: r.cree, serveur: { numero: r.dto.numero } };
        }
        this.exiger(auth, 'membre.modifier');
        // `numero`, `etat`, `statut_adhesion`, `user_id` ne sont jamais repris de l'appareil.
        const champs = versApi('membres', ligne, true);
        delete champs.dateAdhesion;
        if (Object.keys(champs).length > 0) {
          await this.membres.modifier(auth, id, valider(membreMajSchema, champs), undefined);
        }
        return {};
      }
      case 'ayants_droit': {
        this.exiger(auth, 'membre.modifier');
        if (operation === 'created') {
          if (typeof ligne.membre_id !== 'string') throw new Rejet('VALIDATION', 'membre_id obligatoire');
          const r = await this.ayantsDroit.creer(
            auth,
            ligne.membre_id,
            valider(ayantDroitSchema, { id, ...versApi('ayants_droit', ligne, false) }) as Record<
              string,
              string
            >,
          );
          return { cree: (r as { cree?: boolean }).cree };
        }
        const membreId = await this.membreDeLAyantDroit(id);
        if (operation === 'deleted') {
          await this.ayantsDroit.supprimer(auth, membreId, id);
          return {};
        }
        await this.ayantsDroit.modifier(
          auth,
          membreId,
          id,
          valider(ayantDroitMajSchema, versApi('ayants_droit', ligne, true)) as Record<string, string>,
        );
        return {};
      }
      case 'paiements': {
        if (operation !== 'created') {
          throw new Rejet(
            'OPERATION_INTERDITE',
            'Un paiement ne se modifie ni ne se supprime (annulation en ligne)',
          );
        }
        this.exiger(auth, 'paiement.enregistrer');
        const p = valider(paiementCreationSchema, {
          id,
          membreId: ligne.membre_id ?? null,
          familleId: ligne.famille_id ?? null,
          campagneId: ligne.campagne_id ?? null,
          montant: ligne.montant,
          mode: ligne.mode,
          operateurMm: ligne.operateur_mm ?? null,
          referenceExterne: ligne.reference_externe ?? null,
          compteId: ligne.compte_id,
          datePaiement: horodatage(ligne.date_paiement),
          numeroRecuProvisoire: ligne.numero_recu_provisoire ?? null,
          confirmationMontantEleve: true,
        });
        const r = await this.paiements.creer(auth, p, {
          synchronisation: true,
          prefixeAppareil: appareil.prefixe_recu,
        });
        return { cree: r.cree, serveur: { numero_recu: r.dto.numeroRecu } };
      }
      case 'depenses':
        throw new Rejet(
          'OPERATION_INTERDITE',
          'Les dépenses se synchroniseront avec le module dépenses (sprint 6)',
        );
      case 'pieces_jointes': {
        if (operation !== 'created') {
          throw new Rejet(
            'OPERATION_INTERDITE',
            'Une pièce jointe ne se modifie pas : déclarez-en une nouvelle',
          );
        }
        const r = await this.pieces.declarer(
          auth,
          valider(pieceJointeSchema, {
            id,
            entiteType: ligne.entite_type,
            entiteId: ligne.entite_id,
            mime: ligne.mime,
            tailleOctets: ligne.taille_octets,
            sha256: ligne.sha256,
          }),
        );
        return { cree: r.cree, serveur: { statut_upload: r.dto.statutUpload } };
      }
      case 'presences': {
        if (operation === 'deleted')
          throw new Rejet('OPERATION_INTERDITE', 'Suppression de présence non permise');
        this.exiger(auth, 'reunion.gerer');
        return this.presence(auth, id, ligne);
      }
    }
  }

  /** Présence à une réunion (Should) : une ligne par membre et réunion, dernier statut reçu. */
  private presence(auth: AuthRequete, id: string, ligne: Ligne) {
    const p = valider(
      z.object({
        reunion_id: z.uuid(),
        membre_id: z.uuid(),
        statut: z.enum(['present', 'absent', 'excuse', 'represente']),
      }),
      ligne,
    );
    return this.db.tx(async (tx) => {
      const ok = await tx.query(
        `SELECT (SELECT count(*) FROM reunions WHERE id = $1 AND deleted_at IS NULL)
              + (SELECT count(*) FROM membres WHERE id = $2 AND deleted_at IS NULL) AS n`,
        [p.reunion_id, p.membre_id],
      );
      if (Number((ok.rows[0] as { n: string }).n) !== 2)
        throw referenceInvalide('reunion_id', 'Réunion ou membre introuvable');
      await tx.query(
        `INSERT INTO presences (id, association_id, reunion_id, membre_id, statut)
         VALUES ($1, app_association_id(), $2, $3, $4)
         ON CONFLICT (reunion_id, membre_id) DO UPDATE SET statut = EXCLUDED.statut, updated_at = now()`,
        [id, p.reunion_id, p.membre_id, p.statut],
      );
      return {};
    }, auth.contexte);
  }

  private async membreDeLAyantDroit(id: string): Promise<string> {
    const r = await this.db.tx((tx) =>
      tx.query<{ membre_id: string }>(`SELECT membre_id FROM ayants_droit WHERE id = $1`, [id]),
    );
    if (!r.rows[0]) throw new Rejet('REFERENCE_INVALIDE', 'Ayant droit introuvable');
    return r.rows[0].membre_id;
  }

  /** Erreur → code de rejet (docs/05 §6) ; `null` pour une erreur inattendue. */
  private versRejet(e: unknown): { code: CodeRejet; message: string } | null {
    if (e instanceof Rejet) return { code: e.code, message: e.message };
    if (!(e instanceof ErreurMetier)) return null;
    const detail = e.erreurs[0]
      ? `${e.detail} (${e.erreurs.map((x) => `${x.champ} : ${x.message}`).join(' ; ')})`
      : e.detail;
    if (e.code === 'VALIDATION' && e.erreurs.some((x) => x.champ === 'montant')) {
      return { code: 'MONTANT_INVALIDE', message: detail };
    }
    if ((CODES_REJET as readonly string[]).includes(e.code))
      return { code: e.code as CodeRejet, message: detail };
    if (e.code === 'INTROUVABLE') return { code: 'REFERENCE_INVALIDE', message: detail };
    return { code: 'VALIDATION', message: detail };
  }

  private async rejetExistant(appareilId: string, table: string, id: string) {
    const r = await this.db.tx((tx) =>
      tx.query<{ code: string; message: string }>(
        `SELECT code, message FROM rejets_sync WHERE appareil_id = $1 AND table_cible = $2 AND element_id = $3`,
        [appareilId, table, id],
      ),
    );
    return r.rows[0];
  }

  private async enregistrerRejet(
    appareilId: string,
    table: string,
    id: string,
    rejet: { code: string; message: string },
    emp: string,
  ): Promise<void> {
    await this.db.tx((tx) =>
      tx.query(
        `INSERT INTO rejets_sync (association_id, appareil_id, table_cible, element_id, code, message, empreinte)
         VALUES (app_association_id(), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (appareil_id, table_cible, element_id)
         DO UPDATE SET code = EXCLUDED.code, message = EXCLUDED.message, empreinte = EXCLUDED.empreinte,
                       acquitte_at = NULL, created_at = now()`,
        [appareilId, table, id, rejet.code, rejet.message.slice(0, 1000), emp],
      ),
    );
  }

  /** E5-04 : acquittement d'un rejet par l'appareil qui l'a reçu (idempotent). */
  acquitter(auth: AuthRequete, id: string) {
    return this.db.tx(async (tx) => {
      const appareil = await this.appareils.courant(tx, auth);
      const r = await tx.query(
        `UPDATE rejets_sync SET acquitte_at = coalesce(acquitte_at, now()) WHERE id = $1 AND appareil_id = $2`,
        [id, appareil.id],
      );
      if ((r.rowCount ?? 0) === 0) throw new ErreurMetier('INTROUVABLE', 'Rejet introuvable');
    });
  }
}

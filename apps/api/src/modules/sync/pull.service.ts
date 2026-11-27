import { Inject, Injectable } from '@nestjs/common';
import {
  comparerVersions,
  SYNC_LIMITE_PULL,
  VERSIONS_SCHEMA_SUPPORTEES,
  type Permission,
  type SyncPull,
} from '@assoflow/contracts';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { CONFIG, type Config } from '../../config.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AppareilsService } from './appareils.service.js';

/** Paramètres communs aux requêtes : $1 curseur, $2 borne ou limite, $3 mes membres, $4 mes familles. */
const CTX = `ctx AS (SELECT $1::bigint AS cur, $3::uuid[] AS mm, $4::uuid[] AS mf)`;
const MM = `(SELECT mm FROM ctx)::uuid[]`;
const MF = `(SELECT mf FROM ctx)::uuid[]`;

interface SpecTable {
  table: string;
  /** Condition pour la vue « bureau » (`membre.lire`) ; `false` = table non envoyée. */
  bureau: string | false;
  /** Condition pour la vue « membre » ; `false` = table non envoyée. */
  membre: string | false;
  /** Permission supplémentaire exigée (vue bureau). */
  permission?: Permission;
}

/** Périmètre synchronisé (docs/05 §2). Alias `t` pour la table. */
export const PERIMETRE: SpecTable[] = [
  { table: 'exercices', bureau: 'true', membre: false },
  { table: 'comptes_tresorerie', bureau: 'true', membre: false },
  { table: 'categories_membres', bureau: 'true', membre: false },
  { table: 'categories_depense', bureau: 'true', membre: false },
  { table: 'familles', bureau: 'true', membre: `t.id = ANY(${MF})` },
  { table: 'membres', bureau: 'true', membre: `t.id = ANY(${MM})` },
  { table: 'ayants_droit', bureau: 'true', membre: `t.membre_id = ANY(${MM})` },
  // Les campagnes (sans donnée personnelle) sont envoyées à tous : un membre ajouté plus tard reçoit leur libellé.
  { table: 'campagnes_cotisation', bureau: 'true', membre: 'true' },
  { table: 'echeances', bureau: 'true', membre: `t.membre_id = ANY(${MM})` },
  { table: 'paiements', bureau: 'true', membre: `(t.membre_id = ANY(${MM}) OR t.famille_id = ANY(${MF}))` },
  { table: 'imputations_paiement', bureau: 'true', membre: `t.membre_id = ANY(${MM})` },
  { table: 'mouvements', bureau: 'true', membre: false, permission: 'tresorerie.lire' },
  { table: 'depenses', bureau: 'true', membre: false, permission: 'depense.lire' },
  { table: 'projets', bureau: 'true', membre: 'true' },
  { table: 'annonces', bureau: 'true', membre: 'true' },
  { table: 'pieces_jointes', bureau: 'true', membre: false },
  { table: 'reunions', bureau: 'true', membre: 'true' },
  { table: 'presences', bureau: 'true', membre: `t.membre_id = ANY(${MM})` },
];

/** Colonnes jamais envoyées (internes, clés de stockage, contrôle d'idempotence). */
const EXCLUES = new Set([
  'association_id',
  'sync_version',
  'deleted_at',
  'empreinte_creation',
  'cle_stockage',
  'photo_cle',
]);

const TYPES_PG = {
  int8: 20,
  numeric: 1700,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  json: 114,
  jsonb: 3802,
};

/** Valeur au format WatermelonDB : entiers, dates en ms epoch, tableaux et JSON sérialisés en texte. */
function convertir(valeur: unknown, champ: pg.FieldDef): unknown {
  if (valeur === null || valeur === undefined) return null;
  switch (champ.dataTypeID) {
    case TYPES_PG.int8:
    case TYPES_PG.numeric:
      return Number(valeur);
    case TYPES_PG.date:
      return Date.parse(`${String(valeur)}T00:00:00Z`);
    case TYPES_PG.timestamp:
    case TYPES_PG.timestamptz:
      return (valeur as Date).getTime();
    case TYPES_PG.json:
    case TYPES_PG.jsonb:
      return JSON.stringify(valeur);
  }
  if (Array.isArray(valeur)) return JSON.stringify(valeur);
  return valeur;
}

export interface ChangesTable {
  created: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  deleted: string[];
}

/**
 * Pull (E5-02, docs/05 §3-4) : lignes de version `> curseur`, toutes tables du périmètre confondues, triées par
 * version. Le compteur étant unique par tenant et sérialisé, une page de `limite` versions est exacte : le curseur
 * renvoyé est la dernière version incluse (page incomplète) ou le compteur courant (page complète).
 */
@Injectable()
export class PullService {
  constructor(
    private readonly db: DatabaseService,
    private readonly appareils: AppareilsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** docs/05 §8 : 426 si l'app ou le schéma local est trop ancien. */
  verifierVersions(versionApp: string | undefined, versionSchema: number): void {
    if (versionApp && comparerVersions(versionApp, this.config.MIN_APP_VERSION) < 0) {
      throw new ErreurMetier(
        'APP_OBSOLETE',
        `Version ${versionApp} trop ancienne (minimum ${this.config.MIN_APP_VERSION}) : mettez l’app à jour`,
      );
    }
    if (!VERSIONS_SCHEMA_SUPPORTEES.includes(versionSchema)) {
      throw new ErreurMetier(
        'SCHEMA_OBSOLETE',
        `Schéma local ${versionSchema} non pris en charge (${VERSIONS_SCHEMA_SUPPORTEES.join(', ')})`,
      );
    }
  }

  /** Empreinte du périmètre (docs/05 §2) : un changement de rôle ou de permissions force une resynchronisation. */
  static empreintePerimetre(permissions: readonly string[]): string {
    return createHash('sha256')
      .update([...permissions].sort().join(','))
      .digest('hex');
  }

  async tirer(auth: AuthRequete, p: SyncPull) {
    this.verifierVersions(p.versionApp, p.versionSchema);
    const limite = p.limite ?? SYNC_LIMITE_PULL;
    return this.db.tx(async (tx) => {
      const appareil = await this.appareils.courant(tx, auth);
      const empreinte = PullService.empreintePerimetre(auth.permissions);
      const compteur = Number(
        (
          await tx.query<{ c: string }>(
            `SELECT sync_counter AS c FROM associations WHERE id = app_association_id()`,
          )
        ).rows[0]!.c,
      );
      const rejets = await this.rejets(tx, appareil.id);
      // Périmètre changé, ou curseur venu d'ailleurs (base restaurée) : resynchronisation complète.
      if (p.curseur > 0 && (appareil.empreinte_perimetre !== empreinte || p.curseur > compteur)) {
        await this.noterPassage(tx, appareil.id, p, 0, null);
        return { changes: {}, curseur: 0, complet: false, reinitialiser: true, rejets };
      }

      const vueBureau = auth.permissions.includes('membre.lire');
      const tables = PERIMETRE.flatMap((s) => {
        const condition = vueBureau ? s.bureau : s.membre;
        if (condition === false) return [];
        if (vueBureau && s.permission && !auth.permissions.includes(s.permission)) return [];
        return [{ table: s.table, condition }];
      });
      const mes = await tx.query<{ mm: string[]; mf: string[] }>(
        `SELECT coalesce(array_agg(m.id), '{}') AS mm,
                coalesce(array_agg(DISTINCT m.famille_id) FILTER (WHERE m.famille_id IS NOT NULL), '{}') AS mf
           FROM membres m WHERE m.user_id = $1 AND m.deleted_at IS NULL`,
        [auth.userId],
      );
      const mm = mes.rows[0]!.mm;
      const mf = mes.rows[0]!.mf;

      // Borne de la page : la `limite`-ième version au-delà du curseur.
      const versions = await tx.query<{ v: string }>(
        `WITH ${CTX}
         SELECT v FROM (${tables
           .map(
             (t) =>
               `SELECT t.sync_version AS v FROM ${t.table} t WHERE ${t.condition} AND t.sync_version > (SELECT cur FROM ctx)`,
           )
           .join(' UNION ALL ')}) x
          ORDER BY v LIMIT $2`,
        [p.curseur, limite + 1, mm, mf],
      );
      const complet = versions.rows.length <= limite;
      const borne = complet ? compteur : Number(versions.rows[limite - 1]!.v);

      // L'association (une ligne) est renvoyée à chaque pull : son `updated_at` change à chaque écriture du
      // tenant (compteur de synchronisation), il ne permet donc pas de détecter un changement de ses paramètres.
      const changes: Record<string, ChangesTable> = {
        associations: { created: [], updated: [await this.association(tx)], deleted: [] },
      };
      for (const t of tables) {
        const r = await tx.query(
          `WITH ${CTX}
           SELECT t.* FROM ${t.table} t
            WHERE ${t.condition} AND t.sync_version > (SELECT cur FROM ctx) AND t.sync_version <= $2
            ORDER BY t.sync_version`,
          [p.curseur, borne, mm, mf],
        );
        if (r.rows.length === 0) continue;
        const c: ChangesTable = { created: [], updated: [], deleted: [] };
        for (const ligne of r.rows as Record<string, unknown>[]) {
          if (ligne.deleted_at) {
            c.deleted.push(String(ligne.id));
            continue;
          }
          const sortie: Record<string, unknown> = {};
          for (const champ of r.fields) {
            if (EXCLUES.has(champ.name)) continue;
            sortie[champ.name] = champ.name === 'id' ? String(ligne.id) : convertir(ligne[champ.name], champ);
          }
          if (t.table === 'membres') sortie.a_photo = Boolean(ligne.photo_cle);
          c.updated.push(sortie);
        }
        changes[t.table] = c;
      }
      await this.noterPassage(tx, appareil.id, p, borne, empreinte);
      return { changes, curseur: borne, complet, reinitialiser: false, rejets };
    });
  }

  /** Paramètres utiles de l'association (docs/05 §2). */
  private async association(tx: Tx): Promise<Record<string, unknown>> {
    const r = await tx.query(
      `SELECT id, nom, sigle, type, village, region, devise, mois_debut_exercice, seuil_double_validation,
              seuil_alerte_solde, journal_public_actif, langue_defaut, statut, updated_at
         FROM associations WHERE id = app_association_id()`,
    );
    const ligne = r.rows[0] as Record<string, unknown>;
    return Object.fromEntries(r.fields.map((f) => [f.name, convertir(ligne[f.name], f)]));
  }

  private async rejets(tx: Tx, appareilId: string) {
    const r = await tx.query<{
      id: string;
      table_cible: string;
      element_id: string;
      code: string;
      message: string;
      created_at: Date;
    }>(
      `SELECT id, table_cible, element_id, code, message, created_at FROM rejets_sync
        WHERE appareil_id = $1 AND acquitte_at IS NULL ORDER BY created_at, id`,
      [appareilId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      table: x.table_cible,
      elementId: x.element_id,
      code: x.code,
      message: x.message,
      createdAt: x.created_at.toISOString(),
    }));
  }

  /** État de l'appareil (A32) : dernière synchronisation, curseur, version, éléments en attente, périmètre. */
  private async noterPassage(
    tx: Tx,
    appareilId: string,
    p: SyncPull,
    curseur: number,
    empreinte: string | null,
  ) {
    await tx.query(
      `UPDATE appareils SET derniere_sync = now(), dernier_curseur = $2, version_app = $3,
              elements_en_attente = coalesce($4, elements_en_attente),
              empreinte_perimetre = coalesce($5, empreinte_perimetre)
        WHERE id = $1`,
      [appareilId, curseur, p.versionApp, p.elementsEnAttente ?? null, empreinte],
    );
  }
}

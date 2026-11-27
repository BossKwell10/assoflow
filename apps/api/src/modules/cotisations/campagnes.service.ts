import { Injectable } from '@nestjs/common';
import {
  genererPeriodes,
  verifierCampagne,
  type CampagneCreation,
  type CampagneMaj,
  type Periode,
  type Periodicite,
} from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { introuvable, invalide, referenceInvalide } from '../../common/base-de-donnees.js';
import { avecEtag, etagDe, verifierIfMatch } from '../../common/concurrence.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { decoderCurseurTri, encoderCurseurTri } from '../../common/pagination.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { IdempotenceService } from '../../infra/idempotence.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AvancesService } from './avances.service.js';

export interface LigneCampagne {
  id: string;
  exercice_id: string;
  libelle: string;
  type: 'ordinaire' | 'exceptionnelle';
  motif: 'projet' | 'deces' | 'evenement' | 'autre' | null;
  projet_id: string | null;
  montant: string;
  periodicite: Periodicite;
  date_debut: string;
  date_fin: string;
  jour_echeance: number;
  categories_cibles: string[];
  statut: 'brouillon' | 'active' | 'cloturee';
  activee_at: Date | null;
  sync_version: string;
  created_at: Date;
}

const COLONNES = `c.id, c.exercice_id, c.libelle, c.type, c.motif, c.projet_id, c.montant, c.periodicite,
  c.date_debut, c.date_fin, c.jour_echeance, c.categories_cibles, c.statut, c.activee_at, c.sync_version,
  c.created_at`;

/** RG-RAP-002 : taux = Σ imputé sur les échéances échues ÷ Σ dû de ces échéances (exonérées exclues). */
const TAUX = `(SELECT CASE WHEN sum(s.montant_du) > 0
                   THEN round(sum(least(s.montant_paye, s.montant_du))::numeric / sum(s.montant_du), 4)
              END
         FROM v_echeances_situation s
        WHERE s.campagne_id = c.id AND NOT s.exoneree AND s.date_echeance <= current_date) AS taux`;

/** Membres ciblés à l'activation (RG-COT-010) : actifs, adhésion active ou dormante, catégories ciblées. */
const FILTRE_CIBLES = `m.etat = 'actif' AND m.statut_adhesion IN ('actif', 'dormant')
  AND m.deleted_at IS NULL AND m.anonymise_at IS NULL
  AND (cardinality($1::uuid[]) = 0 OR m.categorie_id = ANY($1::uuid[]))`;

function periodesDe(
  l: Pick<LigneCampagne, 'periodicite' | 'date_debut' | 'date_fin' | 'jour_echeance'>,
): Periode[] {
  return genererPeriodes({
    periodicite: l.periodicite,
    dateDebut: l.date_debut,
    dateFin: l.date_fin,
    jourEcheance: l.jour_echeance,
  });
}

export function versDto(l: LigneCampagne & { taux?: string | null }) {
  return avecEtag(
    {
      id: l.id,
      exerciceId: l.exercice_id,
      libelle: l.libelle,
      type: l.type,
      motif: l.motif,
      projetId: l.projet_id,
      montant: Number(l.montant),
      periodicite: l.periodicite,
      dateDebut: l.date_debut,
      dateFin: l.date_fin,
      jourEcheance: l.jour_echeance,
      categoriesCibles: l.categories_cibles,
      statut: l.statut,
      activeeAt: l.activee_at?.toISOString() ?? null,
      nombrePeriodes: periodesDe(l).length,
      tauxRecouvrement: l.taux === undefined || l.taux === null ? null : Number(l.taux),
    },
    l.sync_version,
  );
}

/** Champs modifiables après activation (RG-COT-013) ; après clôture, le libellé seulement. */
const MODIFIABLES_ACTIVE: (keyof CampagneMaj)[] = ['libelle', 'dateFin', 'montant'];

/**
 * Campagnes de cotisation et échéancier (E4-01 à E4-03, RF-030, RF-031, RF-037, RG-COT-001, 010 à 015, 022).
 * Les dates d'une campagne restent dans son exercice (RG-EXE-002 : aucune écriture dans un exercice clôturé).
 */
@Injectable()
export class CampagnesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly avances: AvancesService,
    private readonly idempotence: IdempotenceService,
  ) {}

  lister(f: { exerciceId?: string; statut?: string; type?: string; limite: number; curseur?: string }) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conditions = ['true'];
    if (f.exerciceId) conditions.push(`c.exercice_id = ${p(f.exerciceId)}`);
    if (f.statut) conditions.push(`c.statut = ${p(f.statut)}`);
    if (f.type) conditions.push(`c.type = ${p(f.type)}`);
    const position = decoderCurseurTri(f.curseur, 'debut');
    if (position) {
      conditions.push(`(c.date_debut, c.id) < (${p(position.valeur)}::date, ${p(position.id)}::uuid)`);
    }
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneCampagne & { taux: string | null }>(
        `SELECT ${COLONNES}, ${TAUX} FROM campagnes_cotisation c WHERE ${conditions.join(' AND ')}
          ORDER BY c.date_debut DESC, c.id DESC LIMIT ${p(f.limite + 1)}`,
        params,
      );
      const lignes = r.rows.slice(0, f.limite);
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map(versDto),
        page: {
          curseurSuivant: derniere
            ? encoderCurseurTri({ tri: 'debut', valeur: derniere.date_debut, id: derniere.id })
            : null,
          total: null,
        },
      };
    });
  }

  lire(id: string) {
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneCampagne & { taux: string | null }>(
        `SELECT ${COLONNES}, ${TAUX} FROM campagnes_cotisation c WHERE c.id = $1`,
        [id],
      );
      if (!r.rows[0]) throw introuvable('Campagne introuvable');
      return versDto(r.rows[0]);
    });
  }

  /** RG-COT-001 : création en brouillon, rien n'est généré. Idempotente avec `Idempotency-Key`. */
  async creer(auth: AuthRequete, p: CampagneCreation, cleIdempotence?: string) {
    const { reponse } = await this.db.tx((tx) =>
      this.idempotence.executer(
        tx,
        {
          associationId: auth.associationId!,
          userId: auth.userId,
          cle: cleIdempotence,
          corps: p,
          statut: 201,
        },
        async () => {
          await this.verifierReferences(tx, p);
          const r = await tx.query<{ id: string }>(
            `INSERT INTO campagnes_cotisation (association_id, exercice_id, libelle, type, motif, projet_id, montant,
                                               periodicite, date_debut, date_fin, jour_echeance, categories_cibles)
             VALUES (app_association_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [
              p.exerciceId,
              p.libelle,
              p.type,
              p.motif ?? null,
              p.projetId ?? null,
              p.montant,
              p.periodicite,
              p.dateDebut,
              p.dateFin,
              p.jourEcheance ?? 5,
              [...new Set(p.categoriesCibles ?? [])],
            ],
          );
          const id = r.rows[0]!.id;
          await this.audit.tracer(tx, {
            associationId: auth.associationId!,
            action: 'campagne.creee',
            entiteType: 'campagne',
            entiteId: id,
            apres: { ...p },
          });
          return versDto(await this.ligne(tx, id));
        },
      ),
    );
    return reponse;
  }

  /**
   * Brouillon : tout est modifiable (RG-COT-001). Active (RG-COT-013) : libellé ; prolongation de la fin (nouvelles
   * périodes pour les membres de la campagne) ; réduction de la fin (suppression des échéances futures sans
   * imputation seulement) ; montant (appliqué aux échéances futures, sans imputation ni ajustement individuel).
   * Clôturée : libellé seulement.
   */
  modifier(auth: AuthRequete, id: string, p: CampagneMaj, ifMatch: string | undefined) {
    return this.db.tx(async (tx) => {
      const l = await this.ligne(tx, id, true);
      verifierIfMatch(ifMatch, etagDe(l.sync_version), auth.canal);
      const avant = this.versCorps(l);
      const changes = Object.fromEntries(
        Object.entries(p).filter(
          ([k, v]) => v !== undefined && JSON.stringify(v) !== JSON.stringify(avant[k as keyof CampagneMaj]),
        ),
      ) as CampagneMaj;
      if (Object.keys(changes).length === 0) return versDto(l);
      if (l.statut !== 'brouillon') {
        const permis = l.statut === 'active' ? MODIFIABLES_ACTIVE : (['libelle'] as (keyof CampagneMaj)[]);
        const interdit = Object.keys(changes).find((k) => !permis.includes(k as keyof CampagneMaj));
        if (interdit) {
          throw invalide(
            interdit,
            'NON_MODIFIABLE',
            l.statut === 'active'
              ? 'Après activation, seuls le libellé, la date de fin et le montant sont modifiables (RG-COT-013)'
              : 'Campagne clôturée : seul le libellé est modifiable',
          );
        }
      }
      const apres = { ...avant, ...changes } as CampagneCreation;
      const erreurs: { champ: string; code: string; message: string }[] = [];
      verifierCampagne(apres, (champ, message) => erreurs.push({ champ, code: 'INVALIDE', message }));
      if (erreurs.length > 0) throw new ErreurMetier('VALIDATION', erreurs[0]!.message, erreurs);
      await this.verifierReferences(tx, apres);

      const effets: Record<string, unknown> = {};
      if (l.statut === 'active') {
        if (changes.dateFin) Object.assign(effets, await this.changerFin(tx, l, changes.dateFin));
        if (changes.montant !== undefined) {
          const r = await tx.query(
            `UPDATE echeances e SET montant_du = $2
              WHERE e.campagne_id = $1 AND e.date_echeance > current_date AND NOT e.exoneree AND e.montant_du = $3
                AND NOT EXISTS (SELECT 1 FROM imputations_paiement i WHERE i.echeance_id = e.id)`,
            [id, changes.montant, l.montant],
          );
          effets.echeancesReevaluees = r.rowCount ?? 0;
        }
      }
      await tx.query(
        `UPDATE campagnes_cotisation SET exercice_id = $2, libelle = $3, type = $4, motif = $5, projet_id = $6,
                montant = $7, periodicite = $8, date_debut = $9, date_fin = $10, jour_echeance = $11,
                categories_cibles = $12
          WHERE id = $1`,
        [
          id,
          apres.exerciceId,
          apres.libelle,
          apres.type,
          apres.motif ?? null,
          apres.projetId ?? null,
          apres.montant,
          apres.periodicite,
          apres.dateDebut,
          apres.dateFin,
          apres.jourEcheance ?? 5,
          [...new Set(apres.categoriesCibles ?? [])],
        ],
      );
      if (l.statut === 'active' && effets.echeancesCreees) {
        const membres = await tx.query<{ membre_id: string }>(
          `SELECT DISTINCT membre_id FROM echeances WHERE campagne_id = $1`,
          [id],
        );
        effets.avancesImputees = (
          await this.avances.imputer(
            tx,
            membres.rows.map((m) => m.membre_id),
          )
        ).montant;
      }
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'campagne.modifiee',
        entiteType: 'campagne',
        entiteId: id,
        avant: Object.fromEntries(Object.keys(changes).map((k) => [k, avant[k as keyof CampagneMaj]])),
        apres: { ...changes, ...effets },
      });
      return versDto(await this.ligne(tx, id));
    });
  }

  /** Aperçu (écran A8) : membres ciblés à cet instant, périodes, nombre d'échéances et montant attendu. */
  apercu(id: string) {
    return this.db.tx(async (tx) => {
      const l = await this.ligne(tx, id);
      const n = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM membres m WHERE ${FILTRE_CIBLES}`,
        [l.categories_cibles],
      );
      const periodes = periodesDe(l);
      const membresCibles = n.rows[0]!.n;
      return {
        membresCibles,
        nombrePeriodes: periodes.length,
        nombreEcheances: membresCibles * periodes.length,
        montantTotal: membresCibles * periodes.length * Number(l.montant),
        periodes: periodes.map((x) => ({
          numero: x.numero,
          libelle: x.libelle,
          dateEcheance: x.dateEcheance,
        })),
      };
    });
  }

  /** RG-COT-010 : activation, génération de l'échéancier des membres ciblés, imputation des avances (RG-COT-022). */
  activer(auth: AuthRequete, id: string) {
    return this.db.tx(async (tx) => {
      const l = await this.ligne(tx, id, true);
      if (l.statut !== 'brouillon') {
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Seule une campagne en brouillon peut être activée');
      }
      await this.verifierReferences(tx, this.versCorps(l) as CampagneCreation);
      const membres = await tx.query<{ id: string }>(
        `SELECT m.id FROM membres m WHERE ${FILTRE_CIBLES} ORDER BY m.numero`,
        [l.categories_cibles],
      );
      const ids = membres.rows.map((m) => m.id);
      const creees = await this.generer(tx, l, periodesDe(l), ids, false);
      await tx.query(`UPDATE campagnes_cotisation SET statut = 'active', activee_at = now() WHERE id = $1`, [
        id,
      ]);
      const avances = await this.avances.imputer(tx, ids);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'campagne.activee',
        entiteType: 'campagne',
        entiteId: id,
        avant: { statut: 'brouillon' },
        apres: {
          statut: 'active',
          membres: ids.length,
          echeancesCreees: creees,
          avancesImputees: avances.montant,
        },
      });
      return versDto(await this.ligne(tx, id));
    });
  }

  /** RG-COT-015 : plus aucune génération ; les échéances restantes restent dues. */
  cloturer(auth: AuthRequete, id: string) {
    return this.db.tx(async (tx) => {
      const l = await this.ligne(tx, id, true);
      if (l.statut !== 'active') {
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Seule une campagne active peut être clôturée');
      }
      await tx.query(`UPDATE campagnes_cotisation SET statut = 'cloturee' WHERE id = $1`, [id]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'campagne.cloturee',
        entiteType: 'campagne',
        entiteId: id,
        avant: { statut: 'active' },
        apres: { statut: 'cloturee' },
      });
      return versDto(await this.ligne(tx, id));
    });
  }

  /**
   * RG-COT-012 : ajout de membres à une campagne active (y compris honoraires et bienfaiteurs). Sans rattrapage,
   * seules les périodes dont l'échéance n'est pas passée à la date d'ajout (et pas avant l'adhésion) sont générées ;
   * avec rattrapage, toutes les périodes. Un membre déjà présent ne reçoit que ses périodes manquantes.
   */
  ajouterMembres(auth: AuthRequete, id: string, membreIds: string[], rattrapage: boolean) {
    return this.db.tx(async (tx) => {
      const l = await this.ligne(tx, id, true);
      if (l.statut !== 'active') {
        throw new ErreurMetier(
          'ETAT_INCOMPATIBLE',
          l.statut === 'brouillon'
            ? 'Campagne en brouillon : les membres ciblés sont ajoutés à l’activation'
            : 'Campagne clôturée : plus aucune échéance n’est générée (RG-COT-015)',
        );
      }
      await this.exerciceOuvert(tx, l.exercice_id);
      const uniques = [...new Set(membreIds)];
      const trouves = await tx.query<{ id: string }>(
        `SELECT id FROM membres WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND anonymise_at IS NULL
            AND etat <> 'desactive'`,
        [uniques],
      );
      const valides = new Set(trouves.rows.map((m) => m.id));
      const manquants = uniques.filter((m) => !valides.has(m));
      if (manquants.length > 0) {
        throw referenceInvalide(
          'membreIds',
          `${manquants.length} membre(s) introuvable(s), désactivé(s) ou anonymisé(s)`,
        );
      }
      const creees = await this.generer(tx, l, periodesDe(l), uniques, !rattrapage);
      const avances = await this.avances.imputer(tx, uniques);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'campagne.membres_ajoutes',
        entiteType: 'campagne',
        entiteId: id,
        apres: { membres: uniques, rattrapage, echeancesCreees: creees, avancesImputees: avances.montant },
      });
      return { echeancesCreees: creees };
    });
  }

  /** RF-075, RG-RAP-002 : attendu, échu, recouvré, taux, et détail par période. */
  statistiques(id: string) {
    return this.db.tx(async (tx) => {
      await this.ligne(tx, id);
      const r = await tx.query<{
        membres: number;
        attendu: string;
        echu: string;
        recouvre: string;
        recouvre_echu: string;
      }>(
        `SELECT count(DISTINCT membre_id)::int AS membres,
                coalesce(sum(montant_du), 0)::bigint AS attendu,
                coalesce(sum(montant_du) FILTER (WHERE date_echeance <= current_date), 0)::bigint AS echu,
                coalesce(sum(least(montant_paye, montant_du)), 0)::bigint AS recouvre,
                coalesce(sum(least(montant_paye, montant_du)) FILTER (WHERE date_echeance <= current_date), 0)::bigint
                  AS recouvre_echu
           FROM v_echeances_situation WHERE campagne_id = $1 AND NOT exoneree`,
        [id],
      );
      const p = await tx.query<{
        numero_periode: number;
        libelle_periode: string;
        date_echeance: string;
        attendu: string;
        recouvre: string;
        en_retard: number;
        payees: number;
      }>(
        `SELECT numero_periode, min(libelle_periode) AS libelle_periode, min(date_echeance)::text AS date_echeance,
                coalesce(sum(montant_du) FILTER (WHERE NOT exoneree), 0)::bigint AS attendu,
                coalesce(sum(least(montant_paye, montant_du)) FILTER (WHERE NOT exoneree), 0)::bigint AS recouvre,
                (count(*) FILTER (WHERE situation = 'en_retard'))::int AS en_retard,
                (count(*) FILTER (WHERE situation = 'payee'))::int AS payees
           FROM v_echeances_situation WHERE campagne_id = $1
          GROUP BY numero_periode ORDER BY numero_periode`,
        [id],
      );
      const s = r.rows[0]!;
      const echu = Number(s.echu);
      return {
        campagneId: id,
        membresCibles: s.membres,
        montantAttendu: Number(s.attendu),
        montantEchuAttendu: echu,
        montantRecouvre: Number(s.recouvre),
        montantRecouvreEchu: Number(s.recouvre_echu),
        tauxRecouvrement: echu > 0 ? Math.round((Number(s.recouvre_echu) / echu) * 10_000) / 10_000 : null,
        parPeriode: p.rows.map((x) => ({
          numeroPeriode: x.numero_periode,
          libellePeriode: x.libelle_periode,
          dateEcheance: x.date_echeance,
          montantAttendu: Number(x.attendu),
          montantRecouvre: Number(x.recouvre),
          echeancesEnRetard: x.en_retard,
          echeancesPayees: x.payees,
        })),
      };
    });
  }

  // --- Interne ------------------------------------------------------------------------------------------------

  async ligne(tx: Tx, id: string, verrouiller = false): Promise<LigneCampagne> {
    const r = await tx.query<LigneCampagne>(
      `SELECT ${COLONNES} FROM campagnes_cotisation c WHERE c.id = $1 ${verrouiller ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!r.rows[0]) throw introuvable('Campagne introuvable');
    return r.rows[0];
  }

  private versCorps(l: LigneCampagne): Required<CampagneMaj> {
    return {
      exerciceId: l.exercice_id,
      libelle: l.libelle,
      type: l.type,
      motif: l.motif,
      projetId: l.projet_id,
      montant: Number(l.montant),
      periodicite: l.periodicite,
      dateDebut: l.date_debut,
      dateFin: l.date_fin,
      jourEcheance: l.jour_echeance,
      categoriesCibles: l.categories_cibles,
    };
  }

  /** RG-EXE-002 : exercice existant et ouvert. */
  async exerciceOuvert(
    tx: Tx,
    id: string,
  ): Promise<{ date_debut: string; date_fin: string; libelle: string }> {
    const r = await tx.query<{ date_debut: string; date_fin: string; libelle: string; statut: string }>(
      `SELECT date_debut, date_fin, libelle, statut FROM exercices WHERE id = $1`,
      [id],
    );
    const ex = r.rows[0];
    if (!ex) throw referenceInvalide('exerciceId', 'Exercice introuvable');
    if (ex.statut !== 'ouvert') {
      throw new ErreurMetier('EXERCICE_FERME', `L’exercice « ${ex.libelle} » est clôturé`, [
        { champ: 'exerciceId', code: 'EXERCICE_FERME', message: 'Exercice clôturé' },
      ]);
    }
    return ex;
  }

  private async verifierReferences(tx: Tx, c: CampagneCreation): Promise<void> {
    const ex = await this.exerciceOuvert(tx, c.exerciceId);
    if (c.dateDebut < ex.date_debut || c.dateFin > ex.date_fin) {
      throw invalide(
        c.dateDebut < ex.date_debut ? 'dateDebut' : 'dateFin',
        'HORS_EXERCICE',
        `Les dates de la campagne doivent rester dans l’exercice « ${ex.libelle} » (${ex.date_debut} → ${ex.date_fin})`,
      );
    }
    const cibles = [...new Set(c.categoriesCibles ?? [])];
    if (cibles.length > 0) {
      const r = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM categories_membres WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [cibles],
      );
      if (r.rows[0]!.n !== cibles.length) {
        throw referenceInvalide('categoriesCibles', 'Catégorie de membres introuvable');
      }
    }
    if (c.projetId) {
      const r = await tx.query(`SELECT 1 FROM projets WHERE id = $1 AND deleted_at IS NULL`, [c.projetId]);
      if ((r.rowCount ?? 0) === 0) throw referenceInvalide('projetId', 'Projet introuvable');
    }
  }

  /**
   * Insère les échéances `periodes` × `membreIds` (déjà présentes ignorées). `nonEchues` : seulement les périodes
   * dont l'échéance n'est pas passée à la date d'ajout ni antérieure à l'adhésion du membre (RG-COT-012).
   */
  private async generer(
    tx: Tx,
    l: LigneCampagne,
    periodes: Periode[],
    membreIds: string[],
    nonEchues: boolean,
  ): Promise<number> {
    if (membreIds.length === 0 || periodes.length === 0) return 0;
    const r = await tx.query(
      `INSERT INTO echeances (association_id, campagne_id, membre_id, numero_periode, libelle_periode, montant_du,
                              date_echeance)
       SELECT app_association_id(), $1, m.id, p.numero, p.libelle, $2, p.date_echeance
         FROM membres m
        CROSS JOIN unnest($3::smallint[], $4::text[], $5::date[]) AS p(numero, libelle, date_echeance)
        WHERE m.id = ANY($6::uuid[])
          AND (NOT $7::boolean OR p.date_echeance >= greatest(m.date_adhesion, current_date))
        ORDER BY m.numero, p.numero
       ON CONFLICT (campagne_id, membre_id, numero_periode) DO NOTHING`,
      [
        l.id,
        l.montant,
        periodes.map((x) => x.numero),
        periodes.map((x) => x.libelle),
        periodes.map((x) => x.dateEcheance),
        membreIds,
        nonEchues,
      ],
    );
    return r.rowCount ?? 0;
  }

  /** RG-COT-013 : prolongation (nouvelles périodes) ou réduction (échéances futures sans imputation supprimées). */
  private async changerFin(tx: Tx, l: LigneCampagne, dateFin: string): Promise<Record<string, unknown>> {
    const avant = periodesDe(l);
    const apres = periodesDe({ ...l, date_fin: dateFin });
    if (apres.length > avant.length || dateFin > l.date_fin) {
      const membres = await tx.query<{ membre_id: string }>(
        `SELECT DISTINCT membre_id FROM echeances WHERE campagne_id = $1`,
        [l.id],
      );
      const nouvelles = apres.filter((x) => x.numero > avant.length);
      const creees = await this.generer(
        tx,
        l,
        nouvelles,
        membres.rows.map((m) => m.membre_id),
        false,
      );
      return { echeancesCreees: creees };
    }
    // Réduction : périodes au-delà de la nouvelle fin, et échéance de la dernière période ramenée à la fin.
    const derniere = apres[apres.length - 1]!;
    const bloquantes = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM echeances e
        WHERE e.campagne_id = $1
          AND (e.numero_periode > $2 OR (e.numero_periode = $2 AND e.date_echeance > $3::date))
          AND (e.date_echeance <= current_date
               OR EXISTS (SELECT 1 FROM imputations_paiement i WHERE i.echeance_id = e.id))`,
      [l.id, derniere.numero, dateFin],
    );
    if (bloquantes.rows[0]!.n > 0) {
      throw new ErreurMetier(
        'ECHEANCE_DEJA_IMPUTEE',
        `${bloquantes.rows[0]!.n} échéance(s) après la nouvelle date de fin sont échues ou déjà payées : réduction impossible (RG-COT-013)`,
        [{ champ: 'dateFin', code: 'ECHEANCE_DEJA_IMPUTEE', message: 'Échéances échues ou payées' }],
      );
    }
    const supprimees = await tx.query(
      `DELETE FROM echeances WHERE campagne_id = $1 AND numero_periode > $2`,
      [l.id, derniere.numero],
    );
    await tx.query(
      `UPDATE echeances SET date_echeance = $3 WHERE campagne_id = $1 AND numero_periode = $2 AND date_echeance > $3`,
      [l.id, derniere.numero, dateFin],
    );
    return { echeancesSupprimees: supprimees.rowCount ?? 0 };
  }
}

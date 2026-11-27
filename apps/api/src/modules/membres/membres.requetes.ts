import { Injectable } from '@nestjs/common';
import { decoderCurseurTri, encoderCurseurTri } from '../../common/pagination.js';
import { DatabaseService } from '../../infra/database.js';
import { COLONNES_MEMBRE, FROM_MEMBRES, MembresLecture, type LigneMembre } from './membres.lecture.js';

export const TRIS_MEMBRES = ['nom', '-nom', 'numero', '-dateAdhesion', 'soldeCotisations'] as const;
export type TriMembres = (typeof TRIS_MEMBRES)[number];

/** Liste blanche des tris (docs/07 §3) : expression SQL, type de la clé pour le curseur, sens. */
const TRIS: Record<TriMembres, { expr: string; type: 'text' | 'date' | 'bigint'; desc: boolean }> = {
  nom: { expr: `app_normaliser(m.nom || ' ' || m.prenoms)`, type: 'text', desc: false },
  '-nom': { expr: `app_normaliser(m.nom || ' ' || m.prenoms)`, type: 'text', desc: true },
  numero: { expr: 'm.numero', type: 'text', desc: false },
  '-dateAdhesion': { expr: 'm.date_adhesion', type: 'date', desc: true },
  // Les plus gros restes dus d'abord (solde = payé − exigible, négatif = reste dû).
  soldeCotisations: {
    expr: 'coalesce(s.total_paye - s.total_exigible, 0)::bigint',
    type: 'bigint',
    desc: false,
  },
};

export interface FiltresMembres {
  q?: string;
  statutAdhesion?: string;
  etat?: string;
  categorieId?: string;
  familleId?: string;
  diaspora?: boolean;
  enRetard?: boolean;
  tri: TriMembres;
  limite: number;
  curseur?: string;
  total?: boolean;
}

const echapperLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Recherche, situation et historique des membres (E3-02, E3-07, RF-025, RF-026, RF-035). */
@Injectable()
export class MembresRequetes {
  constructor(
    private readonly db: DatabaseService,
    private readonly lecture: MembresLecture,
  ) {}

  /**
   * RF-025 : `q` sur nom et prénoms (dans les deux ordres, sans accents ni casse), numéro et téléphone
   * (chiffres saisis contenus dans le numéro E.164). Les membres désactivés sont masqués par défaut (RG-MBR-004).
   */
  async lister(f: FiltresMembres) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conditions = ['m.deleted_at IS NULL'];
    const q = f.q?.trim();
    if (q) {
      const motif = p(`%${echapperLike(q)}%`);
      const alternatives = [
        `app_normaliser(m.nom || ' ' || m.prenoms) LIKE app_normaliser(${motif})`,
        `app_normaliser(m.prenoms || ' ' || m.nom) LIKE app_normaliser(${motif})`,
        `m.numero ILIKE ${motif}`,
      ];
      const chiffres = q.replace(/\D/g, '');
      if (chiffres.length >= 4 && /^[\d\s+.()-]+$/.test(q))
        alternatives.push(`m.telephone LIKE ${p(`%${chiffres}%`)}`);
      conditions.push(`(${alternatives.join(' OR ')})`);
    }
    if (f.etat) conditions.push(`m.etat = ${p(f.etat)}`);
    else conditions.push(`m.etat <> 'desactive'`);
    if (f.statutAdhesion) conditions.push(`m.statut_adhesion = ${p(f.statutAdhesion)}`);
    if (f.categorieId) conditions.push(`m.categorie_id = ${p(f.categorieId)}`);
    if (f.familleId) conditions.push(`m.famille_id = ${p(f.familleId)}`);
    if (f.diaspora !== undefined) conditions.push(`m.est_diaspora = ${p(f.diaspora)}`);
    if (f.enRetard !== undefined) {
      conditions.push(
        `${f.enRetard ? '' : 'NOT '}EXISTS (SELECT 1 FROM v_echeances_situation e
                WHERE e.membre_id = m.id AND e.situation = 'en_retard')`,
      );
    }
    const where = conditions.join(' AND ');
    const filtresParams = [...params];

    const tri = TRIS[f.tri];
    const position = decoderCurseurTri(f.curseur, f.tri);
    const sens = tri.desc ? 'DESC' : 'ASC';
    let apres = '';
    if (position) {
      apres = `AND (cle_tri, id) ${tri.desc ? '<' : '>'} (${p(position.valeur)}::${tri.type}, ${p(position.id)}::uuid)`;
    }
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneMembre & { cle_tri_texte: string }>(
        `WITH base AS (
           SELECT ${COLONNES_MEMBRE}, ${tri.expr} AS cle_tri ${FROM_MEMBRES} WHERE ${where}
         )
         SELECT *, cle_tri::text AS cle_tri_texte FROM base WHERE true ${apres}
         ORDER BY cle_tri ${sens}, id ${sens} LIMIT ${p(f.limite + 1)}`,
        params,
      );
      const lignes = r.rows.slice(0, f.limite);
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      let total: number | null = null;
      if (f.total) {
        const c = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM membres m WHERE ${where}`,
          filtresParams,
        );
        total = c.rows[0]!.n;
      }
      return {
        donnees: await this.lecture.versDtos(lignes),
        page: {
          curseurSuivant: derniere
            ? encoderCurseurTri({ tri: f.tri, valeur: derniere.cle_tri_texte, id: derniere.id })
            : null,
          total,
        },
      };
    });
  }

  /** RF-035 : situation de cotisation, depuis `v_soldes_membres` et `v_echeances_situation`. */
  situation(id: string) {
    return this.db.tx(async (tx) => {
      await this.lecture.ligne(tx, id);
      const r = await tx.query<{
        total_exigible: string;
        total_paye: string;
        reste_du: string;
        avance: string;
        en_retard: number;
      }>(
        `SELECT coalesce(s.total_exigible, 0) AS total_exigible, coalesce(s.total_paye, 0) AS total_paye,
                (SELECT coalesce(sum(greatest(e.montant_du - e.montant_paye, 0)), 0) FROM v_echeances_situation e
                  WHERE e.membre_id = $1 AND e.date_echeance <= current_date) AS reste_du,
                (SELECT coalesce(sum(i.montant), 0) FROM imputations_paiement i
                  WHERE i.membre_id = $1 AND i.echeance_id IS NULL) AS avance,
                (SELECT count(*)::int FROM v_echeances_situation e
                  WHERE e.membre_id = $1 AND e.situation = 'en_retard') AS en_retard
           FROM (SELECT $1::uuid AS id) x LEFT JOIN v_soldes_membres s ON s.membre_id = x.id`,
        [id],
      );
      const prochaine = await tx.query<{
        id: string;
        campagne_id: string;
        campagne_libelle: string;
        membre_id: string;
        membre_numero: string;
        membre_nom: string;
        numero_periode: number;
        libelle_periode: string;
        montant_du: string;
        montant_paye: string;
        date_echeance: string;
        situation: string;
        motif_exoneration: string | null;
      }>(
        `SELECT e.id, e.campagne_id, c.libelle AS campagne_libelle, e.membre_id, m.numero AS membre_numero,
                m.prenoms || ' ' || m.nom AS membre_nom, e.numero_periode, e.libelle_periode, e.montant_du,
                e.montant_paye, e.date_echeance, e.situation, ec.motif_exoneration
           FROM v_echeances_situation e
           JOIN echeances ec ON ec.id = e.id
           JOIN campagnes_cotisation c ON c.id = e.campagne_id
           JOIN membres m ON m.id = e.membre_id
          WHERE e.membre_id = $1 AND e.date_echeance >= current_date AND e.situation IN ('a_venir', 'partielle')
          ORDER BY e.date_echeance, e.id LIMIT 1`,
        [id],
      );
      const s = r.rows[0]!;
      const e = prochaine.rows[0];
      return {
        membreId: id,
        totalExigible: Number(s.total_exigible),
        totalPaye: Number(s.total_paye),
        resteDu: Number(s.reste_du),
        avance: Math.max(Number(s.avance), 0),
        echeancesEnRetard: s.en_retard,
        prochaineEcheance: e
          ? {
              id: e.id,
              campagneId: e.campagne_id,
              campagneLibelle: e.campagne_libelle,
              membreId: e.membre_id,
              membreNumero: e.membre_numero,
              membreNom: e.membre_nom,
              numeroPeriode: e.numero_periode,
              libellePeriode: e.libelle_periode,
              montantDu: Number(e.montant_du),
              montantPaye: Number(e.montant_paye),
              dateEcheance: e.date_echeance,
              situation: e.situation,
              motifExoneration: e.motif_exoneration,
            }
          : null,
      };
    });
  }

  /**
   * RF-026 : chronologie d'un membre, du plus récent au plus ancien. Sources : journal d'audit (création,
   * modifications, changements d'état, ayants droit) et paiements (directs, ou groupés de sa famille qui l'ont crédité).
   * Les libellés ne reprennent aucune donnée personnelle (fiches anonymisées comprises).
   */
  historique(id: string, limite: number, curseur?: string) {
    const position = decoderCurseurTri(curseur, 'historique');
    return this.db.tx(async (tx) => {
      await this.lecture.ligne(tx, id);
      const r = await tx.query<{
        date: Date;
        date_texte: string;
        cle: string;
        action: string;
        apres: Record<string, unknown> | null;
        montant: string | null;
        reference: string | null;
        ref_id: string | null;
      }>(
        `WITH ev AS (
           SELECT a.created_at AS date, 'a' || lpad(a.id::text, 19, '0') AS cle, a.action, a.apres,
                  NULL::bigint AS montant, NULL::text AS reference, a.entite_id AS ref_id
             FROM audit_log a
            WHERE a.association_id = app_association_id()
              AND ((a.entite_type = 'membre' AND a.entite_id = $1::text)
                   OR (a.entite_type = 'ayant_droit' AND a.apres->>'membreId' = $1::text))
           UNION ALL
           SELECT p.date_paiement, 'p' || p.id::text, 'paiement.' || p.type, NULL, p.montant, p.numero_recu,
                  p.id::text
             FROM paiements p
            WHERE p.membre_id = $1::uuid
               OR (p.famille_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM imputations_paiement i WHERE i.paiement_id = p.id AND i.membre_id = $1::uuid))
         )
         SELECT *, date::text AS date_texte FROM ev
          WHERE $2::timestamptz IS NULL OR (date, cle) < ($2::timestamptz, $3::text)
          ORDER BY date DESC, cle DESC LIMIT $4`,
        [id, position?.valeur ?? null, position?.id ?? null, limite + 1],
      );
      const lignes = r.rows.slice(0, limite);
      const derniere = r.rows.length > limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map((l) => ({
          date: l.date.toISOString(),
          ...libeller(l.action, l.apres, l.reference),
          montant: l.montant === null ? null : Number(l.montant),
          refId: l.ref_id,
        })),
        page: {
          curseurSuivant: derniere
            ? encoderCurseurTri({ tri: 'historique', valeur: derniere.date_texte, id: derniere.cle })
            : null,
          total: null,
        },
      };
    });
  }
}

type TypeEvenement = 'creation' | 'paiement' | 'annulation' | 'aide' | 'presence' | 'statut' | 'modification';

const NOMS_CHAMPS: Record<string, string> = {
  nom: 'nom',
  prenoms: 'prénoms',
  sexe: 'sexe',
  dateNaissance: 'date de naissance',
  telephone: 'téléphone',
  telephoneWhatsapp: 'WhatsApp',
  email: 'email',
  villageOrigine: 'village d’origine',
  lieuResidence: 'lieu de résidence',
  paysResidence: 'pays de résidence',
  categorieId: 'catégorie',
  familleId: 'famille',
  statutAdhesion: 'statut d’adhésion',
  canalPrefere: 'canal préféré',
  notes: 'notes',
};

function libeller(
  action: string,
  apres: Record<string, unknown> | null,
  reference: string | null,
): { type: TypeEvenement; libelle: string } {
  const motif = typeof apres?.motif === 'string' ? ` : ${apres.motif}` : '';
  switch (action) {
    case 'membre.cree':
      return { type: 'creation', libelle: `Fiche créée (${String(apres?.numero ?? '')})` };
    case 'membre.modifie': {
      const champs = Object.keys(apres ?? {})
        .map((c) => NOMS_CHAMPS[c])
        .filter(Boolean);
      return { type: 'modification', libelle: `Fiche modifiée : ${champs.join(', ')}` };
    }
    case 'membre.photo_modifiee':
      return { type: 'modification', libelle: 'Photo modifiée' };
    case 'membre.doublon_ecarte':
      return { type: 'modification', libelle: 'Doublon probable écarté' };
    case 'membre.suspendu':
      return { type: 'statut', libelle: `Suspendu${motif}` };
    case 'membre.desactive':
      return { type: 'statut', libelle: `Désactivé${motif}` };
    case 'membre.reactive':
      return { type: 'statut', libelle: 'Réactivé' };
    case 'membre.anonymise':
      return { type: 'statut', libelle: 'Fiche anonymisée' };
    case 'membre.passe_dormant':
      return { type: 'statut', libelle: 'Passé en dormant (retard de cotisation, automatique)' };
    case 'membre.reactive_paiement':
      return { type: 'statut', libelle: 'Redevenu actif (paiement reçu)' };
    case 'ayant_droit.cree':
      return { type: 'modification', libelle: 'Ayant droit ajouté' };
    case 'ayant_droit.modifie':
      return { type: 'modification', libelle: 'Ayant droit modifié' };
    case 'ayant_droit.supprime':
      return { type: 'modification', libelle: 'Ayant droit retiré' };
    case 'paiement.paiement':
      return { type: 'paiement', libelle: `Paiement ${reference ?? ''}`.trim() };
    case 'paiement.annulation':
      return { type: 'annulation', libelle: `Annulation ${reference ?? ''}`.trim() };
    default:
      return { type: 'modification', libelle: action };
  }
}

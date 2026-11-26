import { Inject, Injectable } from '@nestjs/common';
import { avecEtag } from '../../common/concurrence.js';
import { introuvable } from '../../common/base-de-donnees.js';
import type { Tx } from '../../infra/database.js';
import { STOCKAGE_OBJETS, type StockageObjets } from '../../infra/stockage/stockage-objets.js';

export interface LigneMembre {
  id: string;
  numero: string;
  nom: string;
  prenoms: string;
  sexe: 'F' | 'M' | null;
  date_naissance: string | null;
  telephone: string | null;
  telephone_whatsapp: boolean;
  email: string | null;
  village_origine: string | null;
  lieu_residence: string | null;
  pays_residence: string;
  est_diaspora: boolean;
  photo_cle: string | null;
  categorie_id: string | null;
  famille_id: string | null;
  statut_adhesion: 'actif' | 'dormant' | 'honoraire' | 'bienfaiteur';
  etat: 'actif' | 'suspendu' | 'desactive';
  motif_etat: string | null;
  date_adhesion: string;
  canal_prefere: 'sms' | 'whatsapp' | 'push' | 'aucun';
  notes: string | null;
  user_id: string | null;
  doublon_de: string | null;
  doublon_statut: 'a_verifier' | 'pas_doublon' | null;
  anonymise_at: Date | null;
  empreinte_creation: string | null;
  sync_version: string;
  created_at: Date;
  updated_at: Date;
  a_acces_app: boolean;
  solde: string;
}

/** Colonnes d'une fiche + accès app + solde (`v_soldes_membres` : total payé − total exigible). */
export const COLONNES_MEMBRE = `m.id, m.numero, m.nom, m.prenoms, m.sexe, m.date_naissance, m.telephone, m.telephone_whatsapp,
       m.email::text AS email, m.village_origine, m.lieu_residence, m.pays_residence::text AS pays_residence,
       m.est_diaspora, m.photo_cle, m.categorie_id, m.famille_id, m.statut_adhesion, m.etat, m.motif_etat,
       m.date_adhesion, m.canal_prefere, m.notes, m.user_id, m.doublon_de, m.doublon_statut, m.anonymise_at,
       m.empreinte_creation, m.sync_version, m.created_at, m.updated_at,
       EXISTS (SELECT 1 FROM acces_association a
                WHERE a.statut = 'actif' AND (a.membre_id = m.id OR a.user_id = m.user_id)) AS a_acces_app,
       coalesce(s.total_paye - s.total_exigible, 0)::bigint AS solde`;

export const FROM_MEMBRES = `FROM membres m LEFT JOIN v_soldes_membres s ON s.membre_id = m.id`;

export type MembreDto = Awaited<ReturnType<MembresLecture['versDto']>>;

/** Lecture des fiches membres et conversion en DTO (schéma `Membre` d'openapi.yaml). */
@Injectable()
export class MembresLecture {
  constructor(@Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets) {}

  /** Fiche non supprimée, relue sous RLS : absente ou d'un autre tenant → 404 (docs/04 §5). */
  async ligne(tx: Tx, id: string, verrouiller = false): Promise<LigneMembre> {
    if (verrouiller) await tx.query(`SELECT 1 FROM membres WHERE id = $1 FOR UPDATE`, [id]);
    const r = await tx.query<LigneMembre>(
      `SELECT ${COLONNES_MEMBRE} ${FROM_MEMBRES} WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [id],
    );
    if (!r.rows[0]) throw introuvable('Membre introuvable');
    return r.rows[0];
  }

  async dto(tx: Tx, id: string) {
    return this.versDto(await this.ligne(tx, id));
  }

  async versDto(l: LigneMembre) {
    const aVerifier = l.doublon_statut === 'a_verifier';
    return avecEtag(
      {
        id: l.id,
        numero: l.numero,
        nom: l.nom,
        prenoms: l.prenoms,
        sexe: l.sexe,
        dateNaissance: l.date_naissance,
        telephone: l.telephone,
        telephoneWhatsapp: l.telephone_whatsapp,
        email: l.email,
        villageOrigine: l.village_origine,
        lieuResidence: l.lieu_residence,
        paysResidence: l.pays_residence,
        estDiaspora: l.est_diaspora,
        photoUrl: l.photo_cle ? await this.stockage.urlLecture(l.photo_cle) : null,
        categorieId: l.categorie_id,
        familleId: l.famille_id,
        statutAdhesion: l.statut_adhesion,
        etat: l.etat,
        motifEtat: l.motif_etat,
        dateAdhesion: l.date_adhesion,
        canalPrefere: l.canal_prefere,
        notes: l.notes,
        aAccesApp: l.a_acces_app,
        soldeCotisations: Number(l.solde),
        doublonProbable: aVerifier,
        doublonDe: aVerifier ? l.doublon_de : null,
        anonymise: l.anonymise_at !== null,
        createdAt: l.created_at.toISOString(),
        updatedAt: l.updated_at.toISOString(),
      },
      l.sync_version,
    );
  }

  versDtos(lignes: LigneMembre[]) {
    return Promise.all(lignes.map((l) => this.versDto(l)));
  }
}

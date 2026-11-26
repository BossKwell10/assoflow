import { Inject, Injectable, Logger } from '@nestjs/common';
import { masquerTelephone, VERSION_CGU, type MembreCreation, type MembreMaj } from '@assoflow/contracts';
import { randomUUID } from 'node:crypto';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import {
  codeSql,
  conflitIdempotence,
  empreinte,
  invalide,
  referenceInvalide,
  VIOLATION_UNICITE,
} from '../../common/base-de-donnees.js';
import { etagDe, verifierIfMatch } from '../../common/concurrence.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import type { Image } from '../../common/images.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { STOCKAGE_OBJETS, type StockageObjets } from '../../infra/stockage/stockage-objets.js';
import { AuditService } from '../audit/audit.service.js';
import { AccesService } from '../utilisateurs/acces.service.js';
import { MembresLecture, type LigneMembre, type MembreDto } from './membres.lecture.js';

/** Champs modifiables d'une fiche : nom d'API → colonne. */
const COLONNES: Record<keyof MembreMaj, keyof LigneMembre> = {
  nom: 'nom',
  prenoms: 'prenoms',
  sexe: 'sexe',
  dateNaissance: 'date_naissance',
  telephone: 'telephone',
  telephoneWhatsapp: 'telephone_whatsapp',
  email: 'email',
  villageOrigine: 'village_origine',
  lieuResidence: 'lieu_residence',
  paysResidence: 'pays_residence',
  categorieId: 'categorie_id',
  familleId: 'famille_id',
  statutAdhesion: 'statut_adhesion',
  canalPrefere: 'canal_prefere',
  notes: 'notes',
};

/** Champs d'identité : leur modification relance la détection de doublon (RG-MBR-003). */
const CHAMPS_IDENTITE: (keyof MembreMaj)[] = ['nom', 'prenoms', 'telephone', 'dateNaissance'];

/** Valeurs par défaut d'une création (alignées sur les défauts de la table `membres`). */
const DEFAUTS = {
  telephoneWhatsapp: false,
  paysResidence: 'CI',
  statutAdhesion: 'actif',
  canalPrefere: 'sms',
} as const;

type Valeurs = Partial<Record<keyof MembreMaj, unknown>>;

/** Masque les téléphones des traces d'audit (docs/02 §6). */
function pourAudit(v: Valeurs): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      k === 'telephone' && typeof x === 'string' ? masquerTelephone(x) : x,
    ]),
  );
}

export type Transition = 'suspendre' | 'desactiver' | 'reactiver';

/** RG-MBR-004 : transitions d'état autorisées. */
const TRANSITIONS: Record<
  Transition,
  { depuis: LigneMembre['etat'][]; vers: LigneMembre['etat']; action: string }
> = {
  suspendre: { depuis: ['actif'], vers: 'suspendu', action: 'membre.suspendu' },
  desactiver: { depuis: ['actif', 'suspendu'], vers: 'desactive', action: 'membre.desactive' },
  reactiver: { depuis: ['suspendu', 'desactive'], vers: 'actif', action: 'membre.reactive' },
};

/** Fiches membres : création, modification, états, anonymisation, photo, doublons, accès app (E3-01 à E3-04, E3-11). */
@Injectable()
export class MembresService {
  private readonly logger = new Logger('Membres');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly lecture: MembresLecture,
    private readonly acces: AccesService,
    @Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets,
  ) {}

  lire(id: string) {
    return this.db.tx((tx) => this.lecture.dto(tx, id));
  }

  /**
   * Création (RF-020) avec l'id UUIDv7 du client comme clé d'idempotence (docs/07 §5) :
   * même id et même contenu → la fiche existante (`cree: false`, 200) ; contenu différent → 409.
   */
  async creer(auth: AuthRequete, p: MembreCreation): Promise<{ dto: MembreDto; cree: boolean }> {
    const { confirmationDoublon, ...contenu } = p;
    const emp = empreinte(contenu);
    const aid = auth.associationId!;
    return this.db.tx(async (tx) => {
      // Deux requêtes simultanées avec le même id : la seconde attend puis rejoue.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`membre:${p.id}`]);
      const existant = await tx.query<{ empreinte_creation: string | null }>(
        `SELECT empreinte_creation FROM membres WHERE id = $1`,
        [p.id],
      );
      if (existant.rows[0]) {
        if (existant.rows[0].empreinte_creation !== emp) throw conflitIdempotence();
        return { dto: await this.lecture.dto(tx, p.id), cree: false };
      }

      const valeurs: Valeurs = { ...DEFAUTS };
      for (const champ of Object.keys(COLONNES) as (keyof MembreMaj)[]) {
        if (p[champ] !== undefined) valeurs[champ] = p[champ];
      }
      if (p.categorieId) await this.verifierCategorie(tx, p.categorieId);
      if (p.familleId) await this.verifierFamille(tx, p.familleId);
      await this.verifierContact(tx, p.telephone ?? null, p.familleId ?? null);

      // RG-MBR-003 : doublon probable → confirmation explicite, puis fiche marquée « à vérifier ».
      const doublon = await this.chercherDoublon(tx, p.id, p);
      if (doublon && !confirmationDoublon) {
        const message = `Doublon probable de ${doublon.numero} — ${doublon.prenoms} ${doublon.nom}`;
        throw new ErreurMetier('CONFIRMATION_REQUISE', `${message} : confirmez l’enregistrement`, [
          { champ: 'confirmationDoublon', code: 'DOUBLON_PROBABLE', message, ref: doublon.id },
        ]);
      }

      // RG-MBR-001 : numéro serveur, sans trou (verrou de ligne sur `compteurs`, annulé avec la transaction).
      const n = await tx.query<{ v: string }>(`SELECT app_prochain_numero('membre', 0::smallint) AS v`);
      const numero = `MBR-${n.rows[0]!.v.padStart(6, '0')}`;
      const champs = Object.keys(valeurs) as (keyof MembreMaj)[];
      const colonnes = [
        'id',
        'association_id',
        'numero',
        'date_adhesion',
        'doublon_de',
        'doublon_statut',
        'empreinte_creation',
        ...champs.map((c) => COLONNES[c]),
      ];
      const parametres = [
        p.id,
        aid,
        numero,
        p.dateAdhesion ?? null,
        doublon?.id ?? null,
        doublon ? 'a_verifier' : null,
        emp,
        ...champs.map((c) => valeurs[c]),
      ];
      try {
        await tx.query(
          `INSERT INTO membres (${colonnes.join(', ')})
           VALUES (${colonnes.map((c, i) => (c === 'date_adhesion' ? `coalesce($${i + 1}::date, current_date)` : `$${i + 1}`)).join(', ')})`,
          parametres,
        );
      } catch (e) {
        // Identifiant déjà pris dans un autre tenant (invisible sous RLS) : conflit, sans révéler l'existence.
        if (codeSql(e) === VIOLATION_UNICITE) throw conflitIdempotence();
        throw e;
      }
      // Consentement au traitement des données recueilli par le bureau (RF-SUP-054, docs/08 A4).
      await tx.query(
        `INSERT INTO consentements (membre_id, association_id, type, version_texte, accorde, recueilli_par, canal)
         VALUES ($1, $2, 'traitement_donnees', $3, true, $4, $5)`,
        [p.id, aid, VERSION_CGU, auth.userId, p.consentement.canal],
      );
      await this.audit.tracer(tx, {
        associationId: aid,
        action: 'membre.cree',
        entiteType: 'membre',
        entiteId: p.id,
        apres: {
          numero,
          ...pourAudit(valeurs),
          consentement: p.consentement.canal,
          ...(doublon ? { doublonDe: doublon.id } : {}),
        },
      });
      return { dto: await this.lecture.dto(tx, p.id), cree: true };
    });
  }

  /** Modification partielle (champs envoyés seulement), `If-Match` vérifié sous verrou de ligne. */
  modifier(auth: AuthRequete, id: string, p: MembreMaj, ifMatch: string | undefined) {
    return this.db.tx(async (tx) => {
      const l = await this.lecture.ligne(tx, id, true);
      verifierIfMatch(ifMatch, etagDe(l.sync_version), auth.canal);
      this.exigerNonAnonymise(l);
      const avant: Valeurs = {};
      const apres: Valeurs = {};
      for (const [champ, colonne] of Object.entries(COLONNES) as [keyof MembreMaj, keyof LigneMembre][]) {
        if (p[champ] === undefined || p[champ] === l[colonne]) continue;
        avant[champ] = l[colonne];
        apres[champ] = p[champ];
      }
      const modifies = Object.keys(apres) as (keyof MembreMaj)[];
      if (modifies.length === 0) return this.lecture.versDto(l);

      const telephone = 'telephone' in apres ? (apres.telephone as string | null) : l.telephone;
      const familleId = 'familleId' in apres ? (apres.familleId as string | null) : l.famille_id;
      if (apres.categorieId) await this.verifierCategorie(tx, apres.categorieId as string);
      if (apres.familleId) await this.verifierFamille(tx, apres.familleId as string);
      await this.verifierContact(tx, telephone, familleId);
      // RG-MBR-006 : le chef d'une famille ne la quitte pas sans qu'un autre chef soit désigné.
      if ('familleId' in apres && l.famille_id) {
        const chef = await tx.query<{ nom: string }>(
          `SELECT nom FROM familles WHERE id = $1 AND chef_famille_id = $2`,
          [l.famille_id, id],
        );
        if (chef.rows[0]) {
          throw invalide(
            'familleId',
            'CHEF_DE_FAMILLE',
            `Ce membre est chef de la famille « ${chef.rows[0].nom} » : désignez d’abord un autre chef (RG-MBR-006)`,
          );
        }
      }
      // RG-MBR-002 : un chef sans téléphone priverait de contact les membres de sa famille qui n'en ont pas.
      if ('telephone' in apres && !telephone) await this.verifierContactFamilleDuChef(tx, id);

      const colonnes = modifies.map((c) => COLONNES[c] as string);
      const signalement: Record<string, unknown> = {};
      const parametres: unknown[] = modifies.map((c) => apres[c]);
      if (modifies.some((c) => CHAMPS_IDENTITE.includes(c)) && l.doublon_statut === null) {
        const doublon = await this.chercherDoublon(tx, id, {
          nom: (apres.nom as string | undefined) ?? l.nom,
          prenoms: (apres.prenoms as string | undefined) ?? l.prenoms,
          telephone,
          dateNaissance: 'dateNaissance' in apres ? (apres.dateNaissance as string | null) : l.date_naissance,
        });
        if (doublon) {
          colonnes.push('doublon_de', 'doublon_statut');
          parametres.push(doublon.id, 'a_verifier');
          signalement.doublonDe = doublon.id;
        }
      }
      await tx.query(
        `UPDATE membres SET ${colonnes.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...parametres],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'membre.modifie',
        entiteType: 'membre',
        entiteId: id,
        avant: pourAudit(avant),
        apres: { ...pourAudit(apres), ...signalement },
      });
      return this.lecture.dto(tx, id);
    });
  }

  /** RG-MBR-004 : suspendre (actif), désactiver (actif, suspendu), réactiver (suspendu, désactivé). */
  changerEtat(auth: AuthRequete, id: string, transition: Transition, motif?: string) {
    const t = TRANSITIONS[transition];
    return this.db.tx(async (tx) => {
      const l = await this.lecture.ligne(tx, id, true);
      this.exigerNonAnonymise(l);
      if (!t.depuis.includes(l.etat)) {
        throw new ErreurMetier('ETAT_INCOMPATIBLE', `Transition impossible depuis l’état « ${l.etat} »`);
      }
      await tx.query(`UPDATE membres SET etat = $2, motif_etat = $3 WHERE id = $1`, [
        id,
        t.vers,
        motif ?? null,
      ]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: t.action,
        entiteType: 'membre',
        entiteId: id,
        avant: { etat: l.etat },
        apres: { etat: t.vers, ...(motif ? { motif } : {}) },
      });
      return this.lecture.dto(tx, id);
    });
  }

  /**
   * RG-MBR-009 : anonymisation irréversible. Identité, contacts, photo, date de naissance, notes et ayants droit
   * effacés ; numéro, paiements et imputations conservés ; fiche désactivée. Refusée si un accès app est actif.
   */
  async anonymiser(auth: AuthRequete, id: string, motif: string) {
    let photo: string | null = null;
    const dto = await this.db.tx(async (tx) => {
      const l = await this.lecture.ligne(tx, id, true);
      this.exigerNonAnonymise(l);
      if (l.a_acces_app) {
        throw new ErreurMetier(
          'ETAT_INCOMPATIBLE',
          'Ce membre a un accès actif à l’application : révoquez-le avant l’anonymisation',
        );
      }
      photo = l.photo_cle;
      const familles = await tx.query<{ id: string }>(
        `UPDATE familles SET chef_famille_id = NULL WHERE chef_famille_id = $1 RETURNING id`,
        [id],
      );
      await tx.query(
        `UPDATE membres SET nom = 'Anonyme', prenoms = '', sexe = NULL, date_naissance = NULL, telephone = NULL,
                telephone_whatsapp = false, email = NULL, village_origine = NULL, lieu_residence = NULL,
                photo_cle = NULL, famille_id = NULL, user_id = NULL, notes = NULL, canal_prefere = 'aucun',
                etat = 'desactive', motif_etat = 'Fiche anonymisée', doublon_statut = NULL, doublon_de = NULL,
                empreinte_creation = NULL, anonymise_at = now()
          WHERE id = $1`,
        [id],
      );
      const ayants = await tx.query(
        `UPDATE ayants_droit SET nom = 'Anonyme', prenoms = '', date_naissance = NULL, empreinte_creation = NULL,
                deleted_at = coalesce(deleted_at, now())
          WHERE membre_id = $1`,
        [id],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'membre.anonymise',
        entiteType: 'membre',
        entiteId: id,
        avant: { etat: l.etat },
        apres: {
          numero: l.numero,
          motif,
          ayantsDroitEffaces: ayants.rowCount ?? 0,
          famillesSansChef: familles.rows.map((f) => f.id),
        },
      });
      return this.lecture.dto(tx, id);
    });
    if (photo) await this.supprimerObjet(photo);
    return dto;
  }

  /** Photo (RF-020) : objet déposé hors transaction, ancienne photo supprimée après le commit. */
  async remplacerPhoto(auth: AuthRequete, id: string, image: Image) {
    const cle = `associations/${auth.associationId!}/membres/${id}/photo-${randomUUID()}.${image.extension}`;
    await this.stockage.deposer(cle, image.contenu, image.type);
    let ancienne: string | null = null;
    try {
      const dto = await this.db.tx(async (tx) => {
        const l = await this.lecture.ligne(tx, id, true);
        this.exigerNonAnonymise(l);
        ancienne = l.photo_cle;
        await tx.query(`UPDATE membres SET photo_cle = $2 WHERE id = $1`, [id, cle]);
        await this.audit.tracer(tx, {
          associationId: auth.associationId!,
          action: 'membre.photo_modifiee',
          entiteType: 'membre',
          entiteId: id,
          apres: { type: image.type, taille: image.contenu.length },
        });
        return this.lecture.dto(tx, id);
      });
      if (ancienne) await this.supprimerObjet(ancienne);
      return dto;
    } catch (e) {
      await this.supprimerObjet(cle);
      throw e;
    }
  }

  /** RG-MBR-003 : fiches marquées doublon probable, à vérifier (écran A7). */
  doublons() {
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `SELECT id FROM membres WHERE doublon_statut = 'a_verifier' AND deleted_at IS NULL ORDER BY created_at, id`,
      );
      return Promise.all(r.rows.map((m) => this.lecture.dto(tx, m.id)));
    });
  }

  /** RG-MBR-003 : « Ce n'est pas un doublon ». */
  ecarterDoublon(auth: AuthRequete, id: string) {
    return this.db.tx(async (tx) => {
      const l = await this.lecture.ligne(tx, id, true);
      if (l.doublon_statut !== 'a_verifier') {
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Cette fiche n’est pas marquée doublon probable');
      }
      await tx.query(`UPDATE membres SET doublon_statut = 'pas_doublon' WHERE id = $1`, [id]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'membre.doublon_ecarte',
        entiteType: 'membre',
        entiteId: id,
        avant: { doublonStatut: 'a_verifier', doublonDe: l.doublon_de },
        apres: { doublonStatut: 'pas_doublon' },
      });
      return this.lecture.dto(tx, id);
    });
  }

  /** Accès à l'app pour un membre : invitation du module accès avec le rôle système `membre` (docs/04 §2.1). */
  async ouvrirAccesApp(auth: AuthRequete, id: string) {
    const { membre, roleId } = await this.db.tx(async (tx) => {
      const l = await this.lecture.ligne(tx, id);
      this.exigerNonAnonymise(l);
      if (l.etat === 'desactive') throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Ce membre est désactivé');
      if (!l.telephone) {
        throw invalide(
          'telephone',
          'TELEPHONE_REQUIS',
          'Un téléphone est nécessaire pour ouvrir l’accès à l’app',
        );
      }
      const role = await tx.query<{ id: string }>(`SELECT id FROM roles WHERE code = 'membre'`);
      if (!role.rows[0]) throw referenceInvalide('roleId', 'Rôle « membre » introuvable');
      return { membre: l, roleId: role.rows[0].id };
    });
    return this.acces.inviter(
      auth,
      { telephone: membre.telephone!, nom: membre.nom, prenoms: membre.prenoms, roleId, membreId: id },
      undefined,
      async (tx, acces) => {
        await tx.query(`UPDATE membres SET user_id = $2 WHERE id = $1`, [id, acces.user.id]);
      },
    );
  }

  // --- Règles partagées -------------------------------------------------------------------------

  private exigerNonAnonymise(l: LigneMembre): void {
    if (l.anonymise_at)
      throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Fiche anonymisée : plus aucune modification');
  }

  private async verifierCategorie(tx: Tx, id: string): Promise<void> {
    const r = await tx.query(
      `SELECT 1 FROM categories_membres WHERE id = $1 AND deleted_at IS NULL AND actif`,
      [id],
    );
    if ((r.rowCount ?? 0) === 0) throw referenceInvalide('categorieId', 'Catégorie introuvable ou inactive');
  }

  private async verifierFamille(tx: Tx, id: string): Promise<void> {
    const r = await tx.query(`SELECT 1 FROM familles WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if ((r.rowCount ?? 0) === 0) throw referenceInvalide('familleId', 'Famille introuvable');
  }

  /** RG-MBR-002 : téléphone, ou famille dont le chef a un téléphone (membres sans téléphone, RF-060). */
  async verifierContact(tx: Tx, telephone: string | null, familleId: string | null): Promise<void> {
    if (telephone) return;
    if (familleId) {
      const r = await tx.query(
        `SELECT 1 FROM familles f JOIN membres c ON c.id = f.chef_famille_id
          WHERE f.id = $1 AND c.telephone IS NOT NULL`,
        [familleId],
      );
      if ((r.rowCount ?? 0) > 0) return;
    }
    throw invalide(
      'telephone',
      'CONTACT_REQUIS',
      'Téléphone obligatoire, ou rattachement à une famille dont le chef a un téléphone (RG-MBR-002)',
    );
  }

  private async verifierContactFamilleDuChef(tx: Tx, chefId: string): Promise<void> {
    const r = await tx.query(
      `SELECT 1 FROM familles f JOIN membres m ON m.famille_id = f.id
        WHERE f.chef_famille_id = $1 AND m.id <> $1 AND m.telephone IS NULL AND m.deleted_at IS NULL LIMIT 1`,
      [chefId],
    );
    if ((r.rowCount ?? 0) > 0) {
      throw invalide(
        'telephone',
        'CONTACT_FAMILLE',
        'Ce chef de famille est le seul contact de membres sans téléphone : son téléphone est obligatoire (RG-MBR-002)',
      );
    }
  }

  /** RG-MBR-003 : même nom + prénoms + téléphone, ou même téléphone + même date de naissance. */
  async chercherDoublon(
    tx: Tx,
    id: string,
    p: { nom: string; prenoms: string; telephone?: string | null; dateNaissance?: string | null },
  ): Promise<{ id: string; numero: string; nom: string; prenoms: string } | null> {
    if (!p.telephone) return null;
    const r = await tx.query<{ id: string; numero: string; nom: string; prenoms: string }>(
      `SELECT id, numero, nom, prenoms FROM membres
        WHERE id <> $1 AND telephone = $2 AND deleted_at IS NULL AND anonymise_at IS NULL
          AND ((app_normaliser(nom) = app_normaliser($3) AND app_normaliser(prenoms) = app_normaliser($4))
               OR ($5::date IS NOT NULL AND date_naissance = $5::date))
        ORDER BY created_at, id LIMIT 1`,
      [id, p.telephone, p.nom, p.prenoms, p.dateNaissance ?? null],
    );
    return r.rows[0] ?? null;
  }

  private async supprimerObjet(cle: string): Promise<void> {
    try {
      await this.stockage.supprimer(cle);
    } catch (e) {
      this.logger.warn(`Suppression de l'objet ${cle} impossible : ${(e as Error).message}`);
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Permission, PieceJointeCreation } from '@assoflow/contracts';
import { createHash } from 'node:crypto';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import {
  conflitIdempotence,
  introuvable,
  invalide,
  referenceInvalide,
} from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { detecterTypeImage } from '../../common/images.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import {
  DUREE_URL_ECRITURE_S,
  STOCKAGE_OBJETS,
  type StockageObjets,
} from '../../infra/stockage/stockage-objets.js';
import { AuditService } from '../audit/audit.service.js';

type Entite = PieceJointeCreation['entiteType'];

/** Droit d'écriture et de lecture d'une pièce jointe selon l'entité (docs/07, `POST /pieces-jointes`). */
const DROITS: Record<Entite, { table: string; ecriture: Permission; lecture: Permission }> = {
  membre: { table: 'membres', ecriture: 'membre.modifier', lecture: 'membre.lire' },
  paiement: { table: 'paiements', ecriture: 'paiement.enregistrer', lecture: 'cotisation.lire' },
  depense: { table: 'depenses', ecriture: 'depense.creer', lecture: 'depense.lire' },
  projet: { table: 'projets', ecriture: 'projet.gerer', lecture: 'projet.lire' },
};

interface LignePiece {
  id: string;
  entite_type: Entite;
  entite_id: string;
  cle_stockage: string;
  mime: string;
  taille_octets: string;
  sha256: string;
  statut_upload: 'en_attente' | 'recu' | 'rejete';
  depose_par: string;
  created_at: Date;
}

function versDto(l: LignePiece) {
  return {
    id: l.id,
    entiteType: l.entite_type,
    entiteId: l.entite_id,
    mime: l.mime,
    tailleOctets: Number(l.taille_octets),
    sha256: l.sha256,
    statutUpload: l.statut_upload,
    createdAt: l.created_at.toISOString(),
  };
}

/** Type réel d'un fichier d'après ses octets de signature (le type déclaré n'est jamais cru). */
export function detecterTypePiece(contenu: Buffer): string | null {
  const image = detecterTypeImage(contenu);
  if (image) return image.type;
  if (contenu.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (contenu.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (contenu.subarray(0, 4).toString('latin1') === 'ADIF') return 'audio/aac';
  if (contenu[0] === 0xff && contenu[1] !== undefined && (contenu[1] & 0xf6) === 0xf0) return 'audio/aac';
  return null;
}

/**
 * Pièces jointes (E5-05, RF-041, docs/05 §7) : métadonnées déclarées (API ou push), fichier envoyé directement au
 * stockage par URL présignée (`PUT`, 10 min), puis confirmé par le serveur (présence, taille, SHA-256, type réel).
 */
@Injectable()
export class PiecesJointesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets,
  ) {}

  private exiger(auth: AuthRequete, permission: Permission, message: string): void {
    if (!auth.permissions.includes(permission)) throw new ErreurMetier('PERMISSION_REFUSEE', message);
  }

  private async ligne(tx: Tx, id: string): Promise<LignePiece> {
    const r = await tx.query<LignePiece>(
      `SELECT id, entite_type, entite_id, cle_stockage, mime, taille_octets, sha256, statut_upload, depose_par,
              created_at
         FROM pieces_jointes WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!r.rows[0]) throw introuvable('Pièce jointe introuvable');
    return r.rows[0];
  }

  /** Déclaration (idempotente par id). Renvoie `cree: false` pour un rejeu identique. */
  async declarer(auth: AuthRequete, p: PieceJointeCreation) {
    const droits = DROITS[p.entiteType];
    this.exiger(auth, droits.ecriture, `Permission requise : ${droits.ecriture}`);
    return this.db.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`piece:${p.id}`]);
      const existant = await tx.query<LignePiece>(
        `SELECT id, entite_type, entite_id, cle_stockage, mime, taille_octets, sha256, statut_upload, depose_par,
                created_at
           FROM pieces_jointes WHERE id = $1`,
        [p.id],
      );
      const e = existant.rows[0];
      if (e) {
        const identique =
          e.entite_type === p.entiteType &&
          e.entite_id === p.entiteId &&
          e.mime === p.mime &&
          Number(e.taille_octets) === p.tailleOctets &&
          e.sha256 === p.sha256.toLowerCase();
        if (!identique) throw conflitIdempotence();
        return { dto: versDto(e), cree: false };
      }
      const entite = await tx.query(`SELECT 1 FROM ${droits.table} WHERE id = $1`, [p.entiteId]);
      if (!entite.rows[0]) throw referenceInvalide('entiteId', 'Élément rattaché introuvable');
      try {
        await tx.query(
          `INSERT INTO pieces_jointes (id, association_id, entite_type, entite_id, cle_stockage, mime, taille_octets,
                                       sha256, depose_par)
           VALUES ($1, app_association_id(), $2, $3, $4, $5, $6, $7, $8)`,
          [
            p.id,
            p.entiteType,
            p.entiteId,
            `pieces/${auth.associationId}/${p.id}`,
            p.mime,
            p.tailleOctets,
            p.sha256.toLowerCase(),
            auth.userId,
          ],
        );
      } catch (e) {
        // Identifiant déjà pris dans un autre tenant (invisible sous RLS).
        if ((e as { code?: string }).code === '23505') throw conflitIdempotence();
        throw e;
      }
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'piece_jointe.declaree',
        entiteType: 'piece_jointe',
        entiteId: p.id,
        apres: { entiteType: p.entiteType, entiteId: p.entiteId, mime: p.mime, tailleOctets: p.tailleOctets },
      });
      return { dto: versDto(await this.ligne(tx, p.id)), cree: true };
    });
  }

  /** Le déposant, ou un titulaire du droit d'écriture sur l'entité. */
  private peutEcrire(auth: AuthRequete, l: LignePiece): void {
    if (l.depose_par !== auth.userId) {
      this.exiger(auth, DROITS[l.entite_type].ecriture, 'Seul le déposant peut envoyer ce fichier');
    }
  }

  async urlUpload(auth: AuthRequete, id: string) {
    const l = await this.db.tx((tx) => this.ligne(tx, id));
    this.peutEcrire(auth, l);
    if (l.statut_upload === 'recu') throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Fichier déjà reçu');
    const { url, entetes } = await this.stockage.urlEcriture(l.cle_stockage, l.mime);
    return {
      url,
      methode: 'PUT' as const,
      entetes,
      expireAt: new Date(Date.now() + DUREE_URL_ECRITURE_S * 1000).toISOString(),
    };
  }

  /**
   * Vérifie le fichier envoyé : absent → 422 (la pièce reste en attente, l'envoi peut être repris) ; taille,
   * empreinte ou type différents → pièce `rejete`, objet supprimé, 422.
   */
  async confirmer(auth: AuthRequete, id: string) {
    const l = await this.db.tx((tx) => this.ligne(tx, id));
    this.peutEcrire(auth, l);
    if (l.statut_upload === 'recu') return versDto(l);
    if (l.statut_upload === 'rejete') {
      throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Pièce rejetée : déclarez une nouvelle pièce');
    }
    const contenu = await this.stockage.contenu(l.cle_stockage);
    if (!contenu)
      throw invalide('fichier', 'FICHIER_ABSENT', 'Aucun fichier reçu : renvoyez-le puis confirmez');
    const sha = createHash('sha256').update(contenu).digest('hex');
    const type = detecterTypePiece(contenu);
    const defaut =
      contenu.length !== Number(l.taille_octets)
        ? {
            code: 'TAILLE_DIFFERENTE',
            message: `Taille reçue ${contenu.length} ≠ ${l.taille_octets} octets déclarés`,
          }
        : sha !== l.sha256
          ? { code: 'EMPREINTE_DIFFERENTE', message: 'Empreinte SHA-256 différente de celle déclarée' }
          : type !== l.mime
            ? { code: 'TYPE_FICHIER_INVALIDE', message: `Type réel ${type ?? 'inconnu'} ≠ ${l.mime}` }
            : null;
    const statut = defaut ? 'rejete' : 'recu';
    const dto = await this.db.tx(async (tx) => {
      await tx.query(`UPDATE pieces_jointes SET statut_upload = $2 WHERE id = $1`, [id, statut]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: defaut ? 'piece_jointe.rejetee' : 'piece_jointe.recue',
        entiteType: 'piece_jointe',
        entiteId: id,
        apres: defaut ? { code: defaut.code } : { tailleOctets: contenu.length },
      });
      return versDto(await this.ligne(tx, id));
    });
    if (defaut) {
      await this.stockage.supprimer(l.cle_stockage).catch(() => undefined);
      throw invalide('fichier', defaut.code, defaut.message);
    }
    return dto;
  }

  async urlTelechargement(auth: AuthRequete, id: string) {
    const l = await this.db.tx((tx) => this.ligne(tx, id));
    const droit = DROITS[l.entite_type].lecture;
    this.exiger(auth, droit, `Permission requise : ${droit}`);
    if (l.statut_upload !== 'recu') throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Fichier pas encore reçu');
    return {
      url: await this.stockage.urlLecture(l.cle_stockage),
      methode: 'GET' as const,
      entetes: {},
      expireAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
}

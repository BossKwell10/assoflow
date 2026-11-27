import { Inject, Injectable } from '@nestjs/common';
import { definirStatut } from '@assoflow/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { genererPdf } from '../../common/pdf.js';
import { detecterTypeImage } from '../../common/images.js';
import { DatabaseService } from '../../infra/database.js';
import { SecretsService } from '../../infra/secrets.js';
import { STOCKAGE_OBJETS, type StockageObjets } from '../../infra/stockage/stockage-objets.js';
import { MembresLecture } from './membres.lecture.js';

const PREFIXE_QR = 'assoflow:m:';

/** Format carte bancaire ISO/IEC 7810 ID-1 (85,6 × 54 mm) en points. */
const CARTE = { width: 242.65, height: 153.07 };

/**
 * Carte de membre (E3-09, RF-023, RG-MBR-008). Le QR code ne contient que
 * `assoflow:m:<association_id>:<membre_id>:<signature>` : HMAC-SHA256 tronqué à 128 bits (base64url), aucune
 * donnée personnelle. L'app mobile vérifie la signature via l'API avant d'afficher la fiche.
 */
@Injectable()
export class CarteMembreService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lecture: MembresLecture,
    private readonly secrets: SecretsService,
    @Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets,
  ) {}

  private signer(associationId: string, membreId: string): string {
    return createHmac('sha256', this.secrets.cleQr)
      .update(`${PREFIXE_QR}${associationId}:${membreId}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }

  contenuQr(associationId: string, membreId: string): string {
    return `${PREFIXE_QR}${associationId}:${membreId}:${this.signer(associationId, membreId)}`;
  }

  /** Lit un QR de carte : identifiants si la signature est valide, `null` sinon. */
  lireQr(texte: string): { associationId: string; membreId: string } | null {
    const r = /^assoflow:m:([0-9a-f-]{36}):([0-9a-f-]{36}):([A-Za-z0-9_-]{22})$/i.exec(texte.trim());
    if (!r) return null;
    const [, associationId, membreId, signature] = r as unknown as [string, string, string, string];
    const attendu = Buffer.from(this.signer(associationId, membreId));
    const recu = Buffer.from(signature);
    return attendu.length === recu.length && timingSafeEqual(attendu, recu)
      ? { associationId, membreId }
      : null;
  }

  /** PDF d'une carte (format ID-1). Refusée pour une fiche anonymisée ou désactivée. */
  async pdf(membreId: string): Promise<{ contenu: Buffer; nomFichier: string }> {
    const donnees = await this.db.tx(async (tx) => {
      const m = await this.lecture.ligne(tx, membreId);
      if (m.anonymise_at) throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Fiche anonymisée : pas de carte');
      if (m.etat === 'desactive')
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Membre désactivé : pas de carte');
      const a = await tx.query<{ id: string; nom: string; sigle: string | null; logo_cle: string | null }>(
        `SELECT id, nom, sigle, logo_cle FROM associations WHERE id = app_association_id()`,
      );
      const c = m.categorie_id
        ? await tx.query<{ libelle: string }>(`SELECT libelle FROM categories_membres WHERE id = $1`, [
            m.categorie_id,
          ])
        : null;
      return { m, a: a.rows[0]!, categorie: c?.rows[0]?.libelle ?? null };
    });
    const { m, a } = donnees;
    const image = async (cle: string | null): Promise<string | null> => {
      if (!cle) return null;
      const contenu = await this.stockage.contenu(cle);
      const type = contenu ? detecterTypeImage(contenu) : null;
      // pdfmake ne lit que PNG et JPEG (un WebP est simplement omis).
      if (!contenu || !type || type.type === 'image/webp') return null;
      return `data:${type.type};base64,${contenu.toString('base64')}`;
    };
    const [logo, photo] = await Promise.all([image(a.logo_cle), image(m.photo_cle)]);
    const dateFr = (d: string) => d.split('-').reverse().join('/');
    const ligne = (libelle: string, valeur: string) => ({
      text: [
        { text: `${libelle} `, color: '#555555' },
        { text: valeur, bold: true },
      ],
      fontSize: 7,
      margin: [0, 1, 0, 0] as [number, number, number, number],
    });

    const definition: TDocumentDefinitions = {
      pageSize: CARTE,
      pageMargins: [10, 8, 10, 8],
      info: { title: `Carte de membre ${m.numero}`, creator: 'AssoFlow' },
      defaultStyle: { font: 'Roboto' },
      content: [
        {
          columns: [
            ...(logo ? [{ image: logo, fit: [24, 24] as [number, number], width: 28 }] : []),
            {
              stack: [
                { text: a.sigle ? `${a.nom} (${a.sigle})` : a.nom, bold: true, fontSize: 8 },
                { text: 'CARTE DE MEMBRE', fontSize: 6, color: '#1c7ed6', characterSpacing: 1 },
              ],
            },
          ],
          columnGap: 4,
        },
        {
          canvas: [
            { type: 'line', x1: 0, y1: 3, x2: CARTE.width - 20, y2: 3, lineWidth: 0.5, lineColor: '#1c7ed6' },
          ],
        },
        {
          margin: [0, 6, 0, 0],
          columns: [
            ...(photo ? [{ image: photo, fit: [52, 64] as [number, number], width: 56 }] : []),
            {
              width: '*',
              stack: [
                { text: m.nom.toUpperCase(), bold: true, fontSize: 9 },
                { text: m.prenoms, fontSize: 8, margin: [0, 0, 0, 3] },
                ligne('N°', m.numero),
                ligne('Statut', definirStatut('membreAdhesion', m.statut_adhesion).libelle),
                ...(donnees.categorie ? [ligne('Catégorie', donnees.categorie)] : []),
                ligne('Membre depuis le', dateFr(m.date_adhesion)),
              ],
            },
            { width: 66, qr: this.contenuQr(a.id, m.id), fit: 66, eccLevel: 'M' },
          ],
          columnGap: 6,
        },
      ],
    };
    return {
      contenu: await genererPdf(definition),
      nomFichier: `carte-${m.numero}.pdf`,
    };
  }
}

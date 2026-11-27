import { Injectable } from '@nestjs/common';
import {
  formatMontant,
  LIBELLES_MODES_PAIEMENT,
  LIBELLES_OPERATEURS_MM,
  type ModePaiement,
  type OperateurMm,
} from '@assoflow/contracts';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { genererPdf } from '../../common/pdf.js';
import { DatabaseService } from '../../infra/database.js';
import { PaiementsService } from './paiements.service.js';

/** Format A5 portrait (points). */
const A5 = { width: 419.53, height: 595.28 };

const dateFr = (iso: string) => {
  const d = new Date(iso);
  const j = (n: number) => String(n).padStart(2, '0');
  return `${j(d.getUTCDate())}/${j(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} à ${j(d.getUTCHours())}:${j(d.getUTCMinutes())}`;
};

/**
 * Reçu PDF (E4-11, RF-033) servi directement (docs/07 §6) : numéro définitif (et provisoire, RG-NUM-002), payeur,
 * montant, mode, ventilation par échéance, avance, reste dû, saisisseur. Un paiement annulé porte la mention
 * « ANNULÉ » et la référence de l'annulation ; une ligne d'annulation est un « reçu d'annulation ».
 */
@Injectable()
export class RecuService {
  constructor(
    private readonly db: DatabaseService,
    private readonly paiements: PaiementsService,
  ) {}

  async pdf(auth: AuthRequete, id: string): Promise<{ contenu: Buffer; nomFichier: string }> {
    const { p, association, resteDu, origine } = await this.db.tx(async (tx) => {
      const p = await this.paiements.dto(tx, auth, id);
      const a = await tx.query<{
        nom: string;
        sigle: string | null;
        village: string;
        telephone: string | null;
      }>(`SELECT nom, sigle, village, telephone FROM associations WHERE id = app_association_id()`);
      const membres = [...new Set(p.imputations.map((i) => i.membreId))];
      const r = await tx.query<{ reste: string }>(
        `SELECT coalesce(sum(greatest(e.montant_du - e.montant_paye, 0)), 0)::bigint AS reste
           FROM v_echeances_situation e WHERE e.membre_id = ANY($1::uuid[]) AND e.date_echeance <= current_date`,
        [membres],
      );
      const origine = p.annulePaiementId
        ? (
            await tx.query<{ numero_recu: string }>(`SELECT numero_recu FROM paiements WHERE id = $1`, [
              p.annulePaiementId,
            ])
          ).rows[0]?.numero_recu
        : null;
      return { p, association: a.rows[0]!, resteDu: Number(r.rows[0]!.reste), origine };
    });

    const annulation = p.type === 'annulation';
    const ligne = (libelle: string, valeur: string): Content => ({
      columns: [
        { text: libelle, width: 120, color: '#555555' },
        { text: valeur, bold: true },
      ],
      margin: [0, 2, 0, 0],
    });
    const payeur = p.familleNom
      ? `Famille ${p.familleNom}`
      : p.membreNom
        ? `${p.membreNom} (${p.membreNumero ?? ''})`
        : '—';
    const mode =
      LIBELLES_MODES_PAIEMENT[p.mode as ModePaiement] +
      (p.operateurMm ? ` — ${LIBELLES_OPERATEURS_MM[p.operateurMm as OperateurMm]}` : '') +
      (p.referenceExterne ? ` (réf. ${p.referenceExterne})` : '');
    const ventilation: Content = {
      table: {
        headerRows: 1,
        widths: ['*', 'auto', 'auto'],
        body: [
          [
            { text: 'Campagne', bold: true },
            { text: 'Période', bold: true },
            { text: 'Montant', bold: true, alignment: 'right' },
          ],
          ...p.imputations.map((i) => [
            i.campagneLibelle ?? (i.montant < 0 ? 'Avance (contre-passée)' : 'Avance'),
            i.libellePeriode ?? '—',
            { text: formatMontant(i.montant), alignment: 'right' as const },
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 8, 0, 0],
      fontSize: 9,
    };

    const definition: TDocumentDefinitions = {
      pageSize: A5,
      pageMargins: [28, 28, 28, 28],
      info: { title: `${annulation ? 'Reçu d’annulation' : 'Reçu'} ${p.numeroRecu}`, creator: 'AssoFlow' },
      defaultStyle: { font: 'Roboto', fontSize: 10 },
      ...(p.annule
        ? {
            watermark: { text: 'ANNULÉ', color: '#c92a2a', opacity: 0.15, bold: true },
          }
        : {}),
      content: [
        {
          text: association.sigle ? `${association.nom} (${association.sigle})` : association.nom,
          bold: true,
          fontSize: 12,
        },
        {
          text: [association.village, association.telephone].filter(Boolean).join(' — '),
          color: '#555555',
          fontSize: 8,
        },
        {
          text: annulation ? 'REÇU D’ANNULATION' : 'REÇU DE PAIEMENT',
          color: annulation ? '#c92a2a' : '#1c7ed6',
          bold: true,
          fontSize: 14,
          margin: [0, 14, 0, 2],
        },
        { text: `N° ${p.numeroRecu}`, bold: true, fontSize: 12 },
        ...(p.numeroRecuProvisoire
          ? [{ text: `Numéro provisoire : ${p.numeroRecuProvisoire}`, fontSize: 8, color: '#555555' }]
          : []),
        { text: ' ', margin: [0, 4, 0, 0] },
        ligne('Date', dateFr(p.datePaiement)),
        ligne(annulation ? 'Concerne' : 'Reçu de', payeur),
        ligne('Montant', formatMontant(annulation ? -p.montant : p.montant)),
        ligne('Mode', mode),
        ligne('Compte', p.compteLibelle),
        ...(annulation
          ? [ligne('Reçu annulé', origine ?? '—'), ligne('Motif', p.motif ?? '—')]
          : [ventilation, ligne('Reste dû à ce jour', formatMontant(resteDu))]),
        ...(p.annulation
          ? [
              {
                text: `Paiement annulé le ${dateFr(p.annulation.datePaiement)} (${p.annulation.numeroRecu}) : ${p.annulation.motif}`,
                color: '#c92a2a',
                margin: [0, 10, 0, 0] as [number, number, number, number],
              },
            ]
          : []),
        {
          text: `Enregistré par ${p.saisiPar.nom} le ${dateFr(p.recuServeurAt)}`,
          fontSize: 8,
          color: '#555555',
          margin: [0, 18, 0, 0],
        },
        { text: 'Document généré par AssoFlow', fontSize: 7, color: '#868e96' },
      ],
    };
    return {
      contenu: await genererPdf(definition),
      nomFichier: `${annulation ? 'annulation' : 'recu'}-${p.numeroRecu}.pdf`,
    };
  }
}

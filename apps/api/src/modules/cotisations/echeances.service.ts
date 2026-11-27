import { Injectable } from '@nestjs/common';
import type { EcheanceMaj } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { introuvable, invalide } from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { decoderCurseurTri, encoderCurseurTri } from '../../common/pagination.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { CampagnesService } from './campagnes.service.js';

interface LigneEcheance {
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
  situation: 'a_venir' | 'partielle' | 'payee' | 'en_retard' | 'exoneree';
  motif_exoneration: string | null;
  imputee: boolean;
}

const SELECT_ECHEANCE = `
  SELECT e.id, e.campagne_id, c.libelle AS campagne_libelle, e.membre_id, m.numero AS membre_numero,
         trim(m.prenoms || ' ' || m.nom) AS membre_nom, e.numero_periode, e.libelle_periode,
         s.montant_du, s.montant_paye, e.date_echeance, s.situation, e.motif_exoneration,
         EXISTS (SELECT 1 FROM imputations_paiement i WHERE i.echeance_id = e.id) AS imputee
    FROM echeances e
    JOIN v_echeances_situation s ON s.id = e.id
    JOIN campagnes_cotisation c ON c.id = e.campagne_id
    JOIN membres m ON m.id = e.membre_id`;

function versDto(l: LigneEcheance) {
  return {
    id: l.id,
    campagneId: l.campagne_id,
    campagneLibelle: l.campagne_libelle,
    membreId: l.membre_id,
    membreNumero: l.membre_numero,
    membreNom: l.membre_nom,
    numeroPeriode: l.numero_periode,
    libellePeriode: l.libelle_periode,
    montantDu: Number(l.montant_du),
    montantPaye: Number(l.montant_paye),
    dateEcheance: l.date_echeance,
    situation: l.situation,
    motifExoneration: l.motif_exoneration,
    imputee: l.imputee,
  };
}

/** Échéances (E4-04, RF-031, RF-035, RG-COT-013, RG-COT-014) et échéancier d'une campagne (écran A9). */
@Injectable()
export class EcheancesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly campagnes: CampagnesService,
  ) {}

  /** Vue transversale (écran A10), par date d'échéance puis id. */
  lister(f: {
    campagneId?: string;
    membreId?: string;
    situation?: string;
    du?: string;
    au?: string;
    limite: number;
    curseur?: string;
  }) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conditions = ['m.deleted_at IS NULL'];
    if (f.campagneId) conditions.push(`e.campagne_id = ${p(f.campagneId)}`);
    if (f.membreId) conditions.push(`e.membre_id = ${p(f.membreId)}`);
    if (f.situation) conditions.push(`s.situation = ${p(f.situation)}`);
    if (f.du) conditions.push(`e.date_echeance >= ${p(f.du)}::date`);
    if (f.au) conditions.push(`e.date_echeance <= ${p(f.au)}::date`);
    const position = decoderCurseurTri(f.curseur, 'date');
    if (position) {
      conditions.push(`(e.date_echeance, e.id) > (${p(position.valeur)}::date, ${p(position.id)}::uuid)`);
    }
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneEcheance>(
        `${SELECT_ECHEANCE} WHERE ${conditions.join(' AND ')}
          ORDER BY e.date_echeance, e.id LIMIT ${p(f.limite + 1)}`,
        params,
      );
      const lignes = r.rows.slice(0, f.limite);
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map(versDto),
        page: {
          curseurSuivant: derniere
            ? encoderCurseurTri({ tri: 'date', valeur: derniere.date_echeance, id: derniere.id })
            : null,
          total: null,
        },
      };
    });
  }

  /**
   * Échéancier membres × périodes d'une campagne (écran A9), paginé par membre (ordre des numéros).
   * `q` filtre sur le nom ou le numéro du membre.
   */
  echeancier(campagneId: string, f: { q?: string; limite: number; curseur?: string }) {
    return this.db.tx(async (tx) => {
      await this.campagnes.ligne(tx, campagneId);
      const params: unknown[] = [campagneId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const conditions = [
        `EXISTS (SELECT 1 FROM echeances e WHERE e.campagne_id = $1 AND e.membre_id = m.id)`,
      ];
      if (f.q?.trim()) {
        const motif = p(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        conditions.push(
          `(app_normaliser(m.prenoms || ' ' || m.nom) LIKE app_normaliser(${motif}) OR m.numero ILIKE ${motif})`,
        );
      }
      const position = decoderCurseurTri(f.curseur, 'numero');
      if (position) conditions.push(`(m.numero, m.id) > (${p(position.valeur)}, ${p(position.id)}::uuid)`);
      const membres = await tx.query<{ id: string; numero: string; nom: string }>(
        `SELECT m.id, m.numero, trim(m.prenoms || ' ' || m.nom) AS nom FROM membres m
          WHERE ${conditions.join(' AND ')} ORDER BY m.numero, m.id LIMIT ${p(f.limite + 1)}`,
        params,
      );
      const page = membres.rows.slice(0, f.limite);
      const derniere = membres.rows.length > f.limite ? page[page.length - 1]! : null;
      const e = await tx.query<LigneEcheance>(
        `${SELECT_ECHEANCE} WHERE e.campagne_id = $1 AND e.membre_id = ANY($2::uuid[])
          ORDER BY e.numero_periode`,
        [campagneId, page.map((m) => m.id)],
      );
      const parMembre = new Map<string, ReturnType<typeof versDto>[]>();
      for (const l of e.rows) {
        const liste = parMembre.get(l.membre_id) ?? [];
        liste.push(versDto(l));
        parMembre.set(l.membre_id, liste);
      }
      return {
        donnees: page.map((m) => ({
          membreId: m.id,
          membreNumero: m.numero,
          membreNom: m.nom,
          echeances: parMembre.get(m.id) ?? [],
        })),
        page: {
          curseurSuivant: derniere
            ? encoderCurseurTri({ tri: 'numero', valeur: derniere.numero, id: derniere.id })
            : null,
          total: null,
        },
      };
    });
  }

  /** E4-04 : ajustement d'une échéance sans imputation (montant, date dans l'exercice). */
  ajuster(auth: AuthRequete, id: string, p: EcheanceMaj) {
    return this.db.tx(async (tx) => {
      const { l, exercice } = await this.modifiable(tx, id);
      const avant: Record<string, unknown> = {};
      const apres: Record<string, unknown> = {};
      if (p.montantDu !== undefined && p.montantDu !== Number(l.montant_du)) {
        avant.montantDu = Number(l.montant_du);
        apres.montantDu = p.montantDu;
      }
      if (p.dateEcheance !== undefined && p.dateEcheance !== l.date_echeance) {
        if (p.dateEcheance < exercice.date_debut || p.dateEcheance > exercice.date_fin) {
          throw invalide(
            'dateEcheance',
            'HORS_EXERCICE',
            `La date doit rester dans l’exercice (${exercice.date_debut} → ${exercice.date_fin})`,
          );
        }
        avant.dateEcheance = l.date_echeance;
        apres.dateEcheance = p.dateEcheance;
      }
      if (Object.keys(apres).length === 0) return versDto(l);
      await tx.query(
        `UPDATE echeances SET montant_du = coalesce($2, montant_du), date_echeance = coalesce($3::date, date_echeance)
          WHERE id = $1`,
        [id, apres.montantDu ?? null, apres.dateEcheance ?? null],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'echeance.ajustee',
        entiteType: 'echeance',
        entiteId: id,
        avant: { ...avant, membre: l.membre_numero, periode: l.libelle_periode },
        apres,
      });
      return versDto(await this.ligne(tx, id));
    });
  }

  /** RG-COT-014 : exonération motivée, refusée si l'échéance a déjà des imputations. */
  exonerer(auth: AuthRequete, id: string, motif: string) {
    return this.db.tx(async (tx) => {
      const { l } = await this.modifiable(tx, id);
      await tx.query(`UPDATE echeances SET exoneree = true, motif_exoneration = $2 WHERE id = $1`, [
        id,
        motif,
      ]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'echeance.exoneree',
        entiteType: 'echeance',
        entiteId: id,
        avant: { montantDu: Number(l.montant_du), membre: l.membre_numero, periode: l.libelle_periode },
        apres: { exoneree: true, motif },
      });
      return versDto(await this.ligne(tx, id));
    });
  }

  private async ligne(tx: Tx, id: string): Promise<LigneEcheance> {
    const r = await tx.query<LigneEcheance>(`${SELECT_ECHEANCE} WHERE e.id = $1`, [id]);
    if (!r.rows[0]) throw introuvable('Échéance introuvable');
    return r.rows[0];
  }

  /** Échéance verrouillée, non exonérée, sans imputation, d'une campagne active dans un exercice ouvert. */
  private async modifiable(tx: Tx, id: string) {
    await tx.query(`SELECT 1 FROM echeances WHERE id = $1 FOR UPDATE`, [id]);
    const l = await this.ligne(tx, id);
    const c = await this.campagnes.ligne(tx, l.campagne_id);
    if (c.statut !== 'active') {
      throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Campagne clôturée : l’échéancier n’est plus modifiable');
    }
    const exercice = await this.campagnes.exerciceOuvert(tx, c.exercice_id);
    if (l.situation === 'exoneree') throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Échéance déjà exonérée');
    if (l.imputee) {
      throw new ErreurMetier(
        'ECHEANCE_DEJA_IMPUTEE',
        'Un paiement est déjà imputé sur cette échéance : elle n’est plus modifiable (RG-COT-013, RG-COT-014)',
      );
    }
    return { l, exercice };
  }
}

import { Injectable } from '@nestjs/common';
import {
  confirmationMontantRequise,
  dateSms,
  masquerTelephone,
  montantSms,
  PRIORITE,
  uuidv7,
  type PaiementCreation,
} from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import {
  codeSql,
  conflitIdempotence,
  empreinte,
  introuvable,
  invalide,
  referenceInvalide,
  VIOLATION_UNICITE,
} from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { decoderCurseur, encoderCurseur } from '../../common/pagination.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { verrouillerImputationsMembre } from '../cotisations/avances.service.js';
import { DormanceService } from '../membres/dormance.service.js';
import { identiteAssociation } from '../notifications/diffusion.service.js';
import { NotificationsService, type ResultatPreparation } from '../notifications/notifications.service.js';
import { TresorerieService } from '../tresorerie/tresorerie.module.js';
import { ventiler, type EcheanceDue } from './imputation.js';

/** RG-COT-041 [D] : un trésorier n'annule que ses propres paiements de moins de 48 h. */
export const DELAI_ANNULATION_H = 48;

interface LignePaiement {
  id: string;
  ts: string;
  type: 'paiement' | 'annulation';
  annule_paiement_id: string | null;
  numero_recu: string;
  numero_recu_provisoire: string | null;
  membre_id: string | null;
  famille_id: string | null;
  campagne_id: string | null;
  montant: string;
  mode: 'especes' | 'mobile_money' | 'virement' | 'cheque';
  operateur_mm: string | null;
  reference_externe: string | null;
  compte_id: string;
  compte_libelle: string;
  date_paiement: Date;
  recu_serveur_at: Date;
  motif: string | null;
  saisi_par: string;
  saisi_par_nom: string;
  exercice_id: string;
  membre_numero: string | null;
  membre_nom: string | null;
  famille_nom: string | null;
  annulation_id: string | null;
  annulation_numero: string | null;
  annulation_motif: string | null;
  annulation_date: Date | null;
  annulation_par: string | null;
  recu_sms: { id: string; statut: string; destinataire: string; relais_famille: boolean } | null;
}

interface LigneImputationDto {
  paiement_id: string;
  echeance_id: string | null;
  membre_id: string;
  libelle_periode: string | null;
  campagne_id: string | null;
  campagne_libelle: string | null;
  date_echeance: string | null;
  montant: string;
}

const SELECT_PAIEMENT = `
  SELECT p.recu_serveur_at::text AS ts, p.id, p.type, p.annule_paiement_id, p.numero_recu, p.numero_recu_provisoire,
         p.membre_id, p.famille_id, p.campagne_id, p.montant, p.mode, p.operateur_mm, p.reference_externe,
         p.compte_id, c.libelle AS compte_libelle, p.date_paiement, p.recu_serveur_at, p.motif, p.saisi_par,
         trim(u.prenoms || ' ' || u.nom) AS saisi_par_nom, p.exercice_id,
         m.numero AS membre_numero, CASE WHEN m.id IS NULL THEN NULL ELSE trim(m.prenoms || ' ' || m.nom) END AS membre_nom,
         f.nom AS famille_nom,
         a.id AS annulation_id, a.numero_recu AS annulation_numero, a.motif AS annulation_motif,
         a.date_paiement AS annulation_date, trim(ua.prenoms || ' ' || ua.nom) AS annulation_par,
         (SELECT json_build_object('id', n.id, 'statut', n.statut, 'destinataire', n.destinataire,
                                   'relais_famille', n.relais_famille)
            FROM notifications n
           WHERE n.origine_id = p.id AND n.origine_type IN ('paiement', 'annulation_paiement')
           ORDER BY n.created_at DESC LIMIT 1) AS recu_sms
    FROM paiements p
    JOIN comptes_tresorerie c ON c.id = p.compte_id
    JOIN users u ON u.id = p.saisi_par
    LEFT JOIN membres m ON m.id = p.membre_id
    LEFT JOIN familles f ON f.id = p.famille_id
    LEFT JOIN paiements a ON a.annule_paiement_id = p.id
    LEFT JOIN users ua ON ua.id = a.saisi_par`;

/** `AAAA-MM-JJ` (GMT, fuseau de la Côte d'Ivoire) d'un horodatage. */
const jourGmt = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export interface FiltresPaiements {
  membreId?: string;
  familleId?: string;
  campagneId?: string;
  mode?: string;
  compteId?: string;
  du?: string;
  au?: string;
  saisiPar?: string;
  inclureAnnules?: boolean;
  limite: number;
  curseur?: string;
}

/**
 * Paiements (E4-05 à E4-09, RF-032 à RF-035, RF-038) : enregistrement en mode connecté avec imputation
 * (RG-COT-020, 021), mouvement de trésorerie (RG-COT-032), numéro de reçu (RG-NUM-001), retour dormant → actif
 * (RG-MBR-005) et SMS de reçu (RF-034) ; annulation par contre-écriture (RG-COT-040, 041). Tables en ajout seul.
 */
@Injectable()
export class PaiementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly tresorerie: TresorerieService,
    private readonly dormance: DormanceService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- Lecture ----------------------------------------------------------------------------------------------

  private versDto(auth: AuthRequete, l: LignePaiement, imputations: LigneImputationDto[]) {
    const peutTout = auth.permissions.includes('paiement.annuler_tout');
    const peutSiens =
      auth.permissions.includes('paiement.annuler') &&
      l.saisi_par === auth.userId &&
      Date.now() - l.recu_serveur_at.getTime() < DELAI_ANNULATION_H * 3600_000;
    return {
      id: l.id,
      type: l.type,
      annulePaiementId: l.annule_paiement_id,
      numeroRecu: l.numero_recu,
      numeroRecuProvisoire: l.numero_recu_provisoire,
      membreId: l.membre_id,
      familleId: l.famille_id,
      campagneId: l.campagne_id,
      montant: Number(l.montant),
      mode: l.mode,
      operateurMm: l.operateur_mm,
      referenceExterne: l.reference_externe,
      compteId: l.compte_id,
      datePaiement: l.date_paiement.toISOString(),
      recuServeurAt: l.recu_serveur_at.toISOString(),
      saisiPar: { id: l.saisi_par, nom: l.saisi_par_nom },
      annule: l.annulation_id !== null,
      imputations: imputations
        .filter((i) => i.paiement_id === l.id)
        .map((i) => ({
          echeanceId: i.echeance_id,
          membreId: i.membre_id,
          libellePeriode: i.libelle_periode,
          campagneId: i.campagne_id,
          campagneLibelle: i.campagne_libelle,
          dateEcheance: i.date_echeance,
          montant: Number(i.montant),
        })),
      motif: l.motif,
      membreNumero: l.membre_numero,
      membreNom: l.membre_nom,
      familleNom: l.famille_nom,
      compteLibelle: l.compte_libelle,
      exerciceId: l.exercice_id,
      annulation: l.annulation_id
        ? {
            id: l.annulation_id,
            numeroRecu: l.annulation_numero!,
            motif: l.annulation_motif!,
            datePaiement: l.annulation_date!.toISOString(),
            saisiPar: l.annulation_par!,
          }
        : null,
      annulable: l.type === 'paiement' && l.annulation_id === null && (peutTout || peutSiens),
      recuSms: l.recu_sms
        ? {
            notificationId: l.recu_sms.id,
            statut: l.recu_sms.statut,
            destinataireMasque: masquerTelephone(l.recu_sms.destinataire),
            relaisFamille: l.recu_sms.relais_famille,
          }
        : null,
    };
  }

  /** Net imputé par paiement et par échéance (les mouvements d'avance internes se compensent). */
  private async imputations(tx: Tx, ids: string[]): Promise<LigneImputationDto[]> {
    if (ids.length === 0) return [];
    const r = await tx.query<LigneImputationDto>(
      `SELECT i.paiement_id, i.echeance_id, i.membre_id, e.libelle_periode, e.campagne_id, c.libelle AS campagne_libelle,
              e.date_echeance, sum(i.montant)::bigint AS montant
         FROM imputations_paiement i
         LEFT JOIN echeances e ON e.id = i.echeance_id
         LEFT JOIN campagnes_cotisation c ON c.id = e.campagne_id
        WHERE i.paiement_id = ANY($1::uuid[])
        GROUP BY i.paiement_id, i.echeance_id, i.membre_id, e.libelle_periode, e.campagne_id, c.libelle, e.date_echeance
       HAVING sum(i.montant) <> 0
        ORDER BY i.paiement_id, e.date_echeance NULLS LAST, e.libelle_periode`,
      [ids],
    );
    return r.rows;
  }

  async dto(tx: Tx, auth: AuthRequete, id: string) {
    const r = await tx.query<LignePaiement>(`${SELECT_PAIEMENT} WHERE p.id = $1`, [id]);
    if (!r.rows[0]) throw introuvable('Paiement introuvable');
    return this.versDto(auth, r.rows[0], await this.imputations(tx, [id]));
  }

  lire(auth: AuthRequete, id: string) {
    return this.db.tx((tx) => this.dto(tx, auth, id));
  }

  /** Écran A11 : plus récents d'abord (ordre de réception). Sans `inclureAnnules`, paiements effectifs seuls. */
  lister(auth: AuthRequete, f: FiltresPaiements) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conditions = ['true'];
    if (!f.inclureAnnules) conditions.push(`p.type = 'paiement' AND a.id IS NULL`);
    if (f.membreId) {
      const m = p(f.membreId);
      conditions.push(
        `(p.membre_id = ${m} OR EXISTS (SELECT 1 FROM imputations_paiement i WHERE i.paiement_id = p.id AND i.membre_id = ${m}))`,
      );
    }
    if (f.familleId) conditions.push(`p.famille_id = ${p(f.familleId)}`);
    if (f.campagneId) {
      const c = p(f.campagneId);
      conditions.push(
        `(p.campagne_id = ${c} OR EXISTS (SELECT 1 FROM imputations_paiement i JOIN echeances e ON e.id = i.echeance_id
                                         WHERE i.paiement_id = p.id AND e.campagne_id = ${c}))`,
      );
    }
    if (f.mode) conditions.push(`p.mode = ${p(f.mode)}`);
    if (f.compteId) conditions.push(`p.compte_id = ${p(f.compteId)}`);
    if (f.saisiPar) conditions.push(`p.saisi_par = ${p(f.saisiPar)}`);
    if (f.du) conditions.push(`p.date_paiement >= ${p(f.du)}::date`);
    if (f.au) conditions.push(`p.date_paiement < ${p(f.au)}::date + 1`);
    const position = decoderCurseur(f.curseur);
    if (position) {
      conditions.push(
        `(p.recu_serveur_at, p.id) < (${p(position.ts)}::timestamptz, ${p(position.id)}::uuid)`,
      );
    }
    return this.db.tx(async (tx) => {
      const r = await tx.query<LignePaiement>(
        `${SELECT_PAIEMENT} WHERE ${conditions.join(' AND ')}
          ORDER BY p.recu_serveur_at DESC, p.id DESC LIMIT ${p(f.limite + 1)}`,
        params,
      );
      const lignes = r.rows.slice(0, f.limite);
      const imputations = await this.imputations(
        tx,
        lignes.map((l) => l.id),
      );
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map((l) => this.versDto(auth, l, imputations)),
        page: {
          curseurSuivant: derniere ? encoderCurseur({ ts: derniere.ts, id: derniere.id }) : null,
          total: null,
        },
      };
    });
  }

  // --- Enregistrement ---------------------------------------------------------------------------------------

  /**
   * Enregistre un paiement (mode connecté). L'id du client est la clé d'idempotence : même id et même corps →
   * le paiement existant (`cree: false`) ; corps différent → 409. Le SMS de reçu part après le commit.
   */
  async creer(auth: AuthRequete, p: PaiementCreation): Promise<{ dto: unknown; cree: boolean }> {
    const { confirmationMontantEleve, ...contenu } = p;
    const emp = empreinte(contenu);
    let notification: ResultatPreparation | null = null;
    const resultat = await this.db.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`paiement:${p.id}`]);
      const existant = await tx.query<{ empreinte_creation: string | null }>(
        `SELECT empreinte_creation FROM paiements WHERE id = $1`,
        [p.id],
      );
      if (existant.rows[0]) {
        if (existant.rows[0].empreinte_creation !== emp) throw conflitIdempotence();
        return { dto: await this.dto(tx, auth, p.id), cree: false };
      }
      // RG-COT-031 : confirmation explicite au-delà de 500 000 FCFA.
      if (confirmationMontantRequise(p.montant) && !confirmationMontantEleve) {
        const message = 'Montant supérieur à 500 000 FCFA : confirmez explicitement le paiement';
        throw new ErreurMetier('CONFIRMATION_REQUISE', message, [
          { champ: 'confirmationMontantEleve', code: 'MONTANT_ELEVE', message },
        ]);
      }
      const datePaiement = new Date(p.datePaiement);
      if (datePaiement.getTime() > Date.now() + 5 * 60_000) {
        throw invalide('datePaiement', 'DATE_FUTURE', 'La date du paiement ne peut pas être dans le futur');
      }
      const date = jourGmt(datePaiement);
      const exercice = await this.tresorerie.exercicePour(tx, date);
      await this.tresorerie.compteActif(tx, p.compteId);

      // Membres concernés : le membre, ou les membres actifs de la famille (RG-COT-021).
      const payeur = p.membreId
        ? await this.membrePayeur(tx, p.membreId)
        : await this.famillePayeuse(tx, p.familleId!);
      if (p.campagneId) {
        const c = await tx.query<{ statut: string }>(
          `SELECT statut FROM campagnes_cotisation WHERE id = $1`,
          [p.campagneId],
        );
        if (!c.rows[0]) throw referenceInvalide('campagneId', 'Campagne introuvable');
        if (c.rows[0].statut === 'brouillon') {
          throw invalide(
            'campagneId',
            'CAMPAGNE_BROUILLON',
            'Campagne en brouillon : aucune échéance à payer',
          );
        }
      }
      const membreIds = payeur.membres.map((m) => m.id);
      await verrouillerImputationsMembre(tx, membreIds);

      const numero = await this.prochainNumeroRecu(tx);
      try {
        await tx.query(
          `INSERT INTO paiements (id, association_id, type, numero_recu, numero_recu_provisoire, membre_id, famille_id,
                                  campagne_id, montant, mode, operateur_mm, reference_externe, compte_id, date_paiement,
                                  saisi_par, appareil_id, exercice_id, empreinte_creation)
           VALUES ($1, app_association_id(), 'paiement', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            p.id,
            numero,
            p.numeroRecuProvisoire ?? null,
            p.membreId ?? null,
            p.familleId ?? null,
            p.campagneId ?? null,
            p.montant,
            p.mode,
            p.operateurMm ?? null,
            p.referenceExterne ?? null,
            p.compteId,
            datePaiement,
            auth.userId,
            auth.appareilId ?? null,
            exercice.id,
            emp,
          ],
        );
      } catch (e) {
        // Identifiant déjà utilisé par un autre tenant (invisible sous RLS) : même réponse qu'un conflit.
        if (codeSql(e) === VIOLATION_UNICITE) throw conflitIdempotence();
        throw e;
      }

      // RG-COT-020 / 021 : imputation sur les échéances non soldées, reste en avance.
      const dues = await tx.query<{
        id: string;
        membre_id: string;
        numero: string;
        campagne_id: string;
        date_echeance: string;
        numero_periode: number;
        reste: string;
        aujourdhui: string;
      }>(
        `SELECT e.id, e.membre_id, m.numero, e.campagne_id, e.date_echeance, e.numero_periode,
                (e.montant_du - e.montant_paye)::bigint AS reste, current_date::text AS aujourdhui
           FROM v_echeances_situation e JOIN membres m ON m.id = e.membre_id
          WHERE e.membre_id = ANY($1::uuid[]) AND NOT e.exoneree AND e.montant_du > e.montant_paye`,
        [membreIds],
      );
      const aujourdhui =
        dues.rows[0]?.aujourdhui ??
        (await tx.query<{ j: string }>(`SELECT current_date::text AS j`)).rows[0]!.j;
      const ventilation = ventiler(
        p.montant,
        dues.rows.map((d): EcheanceDue => ({
          id: d.id,
          membreId: d.membre_id,
          numeroMembre: d.numero,
          campagneId: d.campagne_id,
          dateEcheance: d.date_echeance,
          numeroPeriode: d.numero_periode,
          reste: Number(d.reste),
        })),
        { campagneId: p.campagneId, aujourdhui },
      );
      const lignes: [string | null, string, number][] = ventilation.lignes.map((l) => [
        l.echeanceId,
        l.membreId,
        l.montant,
      ]);
      if (ventilation.avance > 0) lignes.push([null, payeur.membreAvance, ventilation.avance]);
      await tx.query(
        `INSERT INTO imputations_paiement (association_id, paiement_id, echeance_id, membre_id, montant)
         SELECT app_association_id(), $1, e, m, x FROM unnest($2::uuid[], $3::uuid[], $4::bigint[]) AS t(e, m, x)`,
        [p.id, lignes.map((l) => l[0]), lignes.map((l) => l[1]), lignes.map((l) => l[2])],
      );

      // RG-COT-032 : mouvement d'entrée dans la même transaction.
      await this.tresorerie.enregistrer(tx, {
        compteId: p.compteId,
        exerciceId: exercice.id,
        sens: 'entree',
        montant: p.montant,
        date,
        origineType: 'paiement',
        origineId: p.id,
        libelle: `Cotisation ${numero} — ${payeur.libelle}`,
        userId: auth.userId,
      });

      // RG-MBR-005 : retour dormant → actif des membres crédités.
      const credites = new Set(lignes.map((l) => l[1]));
      for (const id of credites) await this.dormance.reactiverApresPaiement(tx, auth.associationId!, id);

      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'paiement.enregistre',
        entiteType: 'paiement',
        entiteId: p.id,
        apres: {
          numeroRecu: numero,
          numeroRecuProvisoire: p.numeroRecuProvisoire ?? null,
          membreId: p.membreId ?? null,
          familleId: p.familleId ?? null,
          campagneId: p.campagneId ?? null,
          montant: p.montant,
          mode: p.mode,
          compteId: p.compteId,
          datePaiement: p.datePaiement,
          imputations: ventilation.lignes.length,
          avance: ventilation.avance,
        },
      });

      // RF-034 : reçu par SMS (outbox), jamais bloqué par le quota.
      notification = await this.preparerRecu(tx, {
        paiementId: p.id,
        numero,
        numeroProvisoire: p.numeroRecuProvisoire ?? null,
        montant: p.montant,
        date,
        destinataire: payeur.destinataire,
        prenoms: payeur.prenoms,
        membreIds,
        cleDedup: `recu:${p.id}`,
      });
      return { dto: await this.dto(tx, auth, p.id), cree: true };
    });
    await this.notifications.publier([notification]);
    return resultat;
  }

  private async membrePayeur(tx: Tx, membreId: string) {
    const r = await tx.query<{
      id: string;
      numero: string;
      nom: string;
      prenoms: string;
      etat: string;
      inactif: boolean;
    }>(
      `SELECT id, numero, nom, prenoms, etat, (deleted_at IS NOT NULL OR anonymise_at IS NOT NULL) AS inactif
         FROM membres WHERE id = $1`,
      [membreId],
    );
    const m = r.rows[0];
    if (!m) throw referenceInvalide('membreId', 'Membre introuvable');
    if (m.inactif)
      throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Fiche anonymisée ou supprimée : paiement impossible');
    // RG-MBR-004 : un membre suspendu peut encore payer ; un membre désactivé doit d'abord être réactivé.
    if (m.etat === 'desactive') {
      throw new ErreurMetier(
        'ETAT_INCOMPATIBLE',
        `${m.numero} est désactivé : réactivez-le avant d’encaisser`,
      );
    }
    return {
      membres: [m],
      membreAvance: m.id,
      destinataire: m.id,
      prenoms: m.prenoms,
      libelle: `${m.numero} ${m.prenoms} ${m.nom}`,
    };
  }

  /**
   * RG-COT-021 : membres actifs de la famille. L'avance éventuelle est portée par le chef de famille (ou, s'il
   * n'est pas actif, par le premier membre par numéro) ; le reçu est envoyé au chef de famille.
   */
  private async famillePayeuse(tx: Tx, familleId: string) {
    const f = await tx.query<{ nom: string; chef_famille_id: string | null }>(
      `SELECT nom, chef_famille_id FROM familles WHERE id = $1 AND deleted_at IS NULL`,
      [familleId],
    );
    if (!f.rows[0]) throw referenceInvalide('familleId', 'Famille introuvable');
    const membres = await tx.query<{ id: string; numero: string; prenoms: string }>(
      `SELECT id, numero, prenoms FROM membres
        WHERE famille_id = $1 AND etat = 'actif' AND deleted_at IS NULL AND anonymise_at IS NULL
        ORDER BY numero`,
      [familleId],
    );
    if (membres.rows.length === 0) {
      throw new ErreurMetier('ETAT_INCOMPATIBLE', `La famille ${f.rows[0].nom} n’a aucun membre actif`);
    }
    const chef = membres.rows.find((m) => m.id === f.rows[0]!.chef_famille_id);
    const porteur = chef ?? membres.rows[0]!;
    return {
      membres: membres.rows,
      membreAvance: porteur.id,
      destinataire: f.rows[0].chef_famille_id ?? porteur.id,
      prenoms: `famille ${f.rows[0].nom}`,
      libelle: `famille ${f.rows[0].nom}`,
    };
  }

  /** RG-NUM-001 : `REC-AAAA-000145`, année civile de réception, séquence sans trou par association. */
  private async prochainNumeroRecu(tx: Tx): Promise<string> {
    const r = await tx.query<{ annee: number; n: string }>(
      `SELECT extract(year FROM now() AT TIME ZONE 'UTC')::int AS annee,
              app_prochain_numero('recu', extract(year FROM now() AT TIME ZONE 'UTC')::smallint) AS n`,
    );
    const { annee, n } = r.rows[0]!;
    return `REC-${annee}-${String(n).padStart(6, '0')}`;
  }

  /** Reste dû échu cumulé des membres (après imputation, dans la transaction). */
  private async resteDu(tx: Tx, membreIds: string[]): Promise<number> {
    const r = await tx.query<{ reste: string }>(
      `SELECT coalesce(sum(greatest(e.montant_du - e.montant_paye, 0)), 0)::bigint AS reste
         FROM v_echeances_situation e WHERE e.membre_id = ANY($1::uuid[]) AND e.date_echeance <= current_date`,
      [membreIds],
    );
    return Number(r.rows[0]!.reste);
  }

  private async preparerRecu(
    tx: Tx,
    r: {
      paiementId: string;
      numero: string;
      numeroProvisoire: string | null;
      montant: number;
      date: string;
      destinataire: string;
      prenoms: string;
      membreIds: string[];
      cleDedup: string | null;
    },
  ): Promise<ResultatPreparation> {
    const association = await identiteAssociation(tx);
    return this.notifications.preparer(tx, {
      code: 'recu_paiement',
      membreId: r.destinataire,
      variables: {
        'association.sigle': association.sigle,
        // RG-NUM-002 : le reçu SMS porte le numéro définitif et, le cas échéant, le provisoire.
        'paiement.numero_recu': r.numeroProvisoire ? `${r.numero} (prov. ${r.numeroProvisoire})` : r.numero,
        'paiement.montant': montantSms(r.montant),
        'membre.prenoms': r.prenoms,
        'paiement.date': dateSms(r.date),
        'membre.reste_du': montantSms(await this.resteDu(tx, r.membreIds)),
      },
      origineType: 'paiement',
      origineId: r.paiementId,
      cleDedup: r.cleDedup,
      priorite: PRIORITE.prioritaire,
    });
  }

  // --- Annulation -------------------------------------------------------------------------------------------

  /**
   * RG-COT-040 : annulation par contre-écriture (nouvelle ligne `annulation` avec son numéro de reçu,
   * contre-imputations, mouvement de sortie daté du jour, SMS d'information). Le paiement d'origine n'est jamais
   * modifié. RG-COT-041 : sans `paiement.annuler_tout`, seulement ses propres paiements de moins de 48 h.
   */
  async annuler(auth: AuthRequete, id: string, motif: string) {
    let notification: ResultatPreparation | null = null;
    const dto = await this.db.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`paiement:${id}`]);
      const r = await tx.query<{
        type: string;
        numero_recu: string;
        membre_id: string | null;
        famille_id: string | null;
        campagne_id: string | null;
        montant: string;
        mode: string;
        operateur_mm: string | null;
        reference_externe: string | null;
        compte_id: string;
        saisi_par: string;
        recent: boolean;
        exercice_statut: string;
        exercice_libelle: string;
        annule: boolean;
        chef_famille_id: string | null;
      }>(
        `SELECT p.type, p.numero_recu, p.membre_id, p.famille_id, p.campagne_id, p.montant, p.mode, p.operateur_mm,
                p.reference_externe, p.compte_id, p.saisi_par,
                p.recu_serveur_at > now() - make_interval(hours => $2) AS recent,
                x.statut AS exercice_statut, x.libelle AS exercice_libelle,
                EXISTS (SELECT 1 FROM paiements a WHERE a.annule_paiement_id = p.id) AS annule,
                f.chef_famille_id
           FROM paiements p JOIN exercices x ON x.id = p.exercice_id
           LEFT JOIN familles f ON f.id = p.famille_id
          WHERE p.id = $1`,
        [id, DELAI_ANNULATION_H],
      );
      const p = r.rows[0];
      if (!p) throw introuvable('Paiement introuvable');
      if (p.type !== 'paiement') {
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Une annulation ne peut pas être annulée');
      }
      if (p.annule) throw new ErreurMetier('ETAT_INCOMPATIBLE', `Le reçu ${p.numero_recu} est déjà annulé`);
      if (!auth.permissions.includes('paiement.annuler_tout') && (p.saisi_par !== auth.userId || !p.recent)) {
        throw new ErreurMetier(
          'PERMISSION_REFUSEE',
          `Vous ne pouvez annuler que vos propres paiements de moins de ${DELAI_ANNULATION_H} h (RG-COT-041)`,
        );
      }
      if (p.exercice_statut !== 'ouvert') {
        throw new ErreurMetier(
          'EXERCICE_FERME',
          `L’exercice « ${p.exercice_libelle} » est clôturé : le paiement ne peut plus être annulé`,
        );
      }
      const aujourdhui = jourGmt(new Date());
      const exercice = await this.tresorerie.exercicePour(tx, aujourdhui, 'motif');
      const membres = await tx.query<{ membre_id: string }>(
        `SELECT DISTINCT membre_id FROM imputations_paiement WHERE paiement_id = $1`,
        [id],
      );
      await verrouillerImputationsMembre(
        tx,
        membres.rows.map((m) => m.membre_id),
      );
      const numero = await this.prochainNumeroRecu(tx);
      const annulationId = uuidv7();
      const montant = Number(p.montant);
      await tx.query(
        `INSERT INTO paiements (id, association_id, type, annule_paiement_id, numero_recu, membre_id, famille_id,
                                campagne_id, montant, mode, operateur_mm, reference_externe, compte_id, date_paiement,
                                motif, saisi_par, exercice_id)
         VALUES ($1, app_association_id(), 'annulation', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, $13, $14)`,
        [
          annulationId,
          id,
          numero,
          p.membre_id,
          p.famille_id,
          p.campagne_id,
          montant,
          p.mode,
          p.operateur_mm,
          p.reference_externe,
          p.compte_id,
          motif,
          auth.userId,
          exercice.id,
        ],
      );
      // Contre-imputations : le net de chaque (échéance, membre) du paiement d'origine, en négatif.
      await tx.query(
        `INSERT INTO imputations_paiement (association_id, paiement_id, echeance_id, membre_id, montant)
         SELECT app_association_id(), $2, echeance_id, membre_id, -sum(montant)
           FROM imputations_paiement WHERE paiement_id = $1
          GROUP BY echeance_id, membre_id HAVING sum(montant) <> 0`,
        [id, annulationId],
      );
      await this.tresorerie.enregistrer(tx, {
        compteId: p.compte_id,
        exerciceId: exercice.id,
        sens: 'sortie',
        montant,
        date: aujourdhui,
        origineType: 'annulation_paiement',
        origineId: annulationId,
        libelle: `Annulation du reçu ${p.numero_recu} (${numero})`,
        userId: auth.userId,
      });
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'paiement.annule',
        entiteType: 'paiement',
        entiteId: id,
        apres: { annulationId, numeroRecu: numero, numeroRecuAnnule: p.numero_recu, montant, motif },
      });
      const association = await identiteAssociation(tx);
      notification = await this.notifications.preparer(tx, {
        code: 'annulation_paiement',
        membreId: p.membre_id ?? p.chef_famille_id,
        variables: {
          'association.sigle': association.sigle,
          'paiement.numero_recu': p.numero_recu,
          'paiement.montant': montantSms(montant),
          motif,
        },
        origineType: 'annulation_paiement',
        origineId: annulationId,
        cleDedup: `annulation:${id}`,
        priorite: PRIORITE.prioritaire,
      });
      return this.dto(tx, auth, annulationId);
    });
    await this.notifications.publier([notification]);
    return dto;
  }

  // --- Renvoi du reçu ---------------------------------------------------------------------------------------

  /** RF-034 : nouvel envoi du reçu (ou de l'avis d'annulation pour une ligne d'annulation). */
  async renvoyerRecu(auth: AuthRequete, id: string) {
    let notification: ResultatPreparation | null = null;
    const dto = await this.db.tx(async (tx) => {
      const r = await tx.query<{
        type: string;
        numero_recu: string;
        numero_recu_provisoire: string | null;
        montant: string;
        date_paiement: Date;
        motif: string | null;
        membre_id: string | null;
        prenoms: string | null;
        famille_nom: string | null;
        chef_famille_id: string | null;
        origine_numero: string | null;
        annule_paiement_id: string | null;
      }>(
        `SELECT p.type, p.numero_recu, p.numero_recu_provisoire, p.montant, p.date_paiement, p.motif, p.membre_id,
                m.prenoms, f.nom AS famille_nom, f.chef_famille_id, o.numero_recu AS origine_numero,
                p.annule_paiement_id
           FROM paiements p
           LEFT JOIN membres m ON m.id = p.membre_id
           LEFT JOIN familles f ON f.id = p.famille_id
           LEFT JOIN paiements o ON o.id = p.annule_paiement_id
          WHERE p.id = $1`,
        [id],
      );
      const p = r.rows[0];
      if (!p) throw introuvable('Paiement introuvable');
      const destinataire = p.membre_id ?? p.chef_famille_id;
      const sansContact = () =>
        invalide(
          'membreId',
          'CONTACT_REQUIS',
          'Ni le membre ni son chef de famille n’a de téléphone joignable, ou le membre refuse les messages',
        );
      if (!destinataire) throw sansContact();
      const association = await identiteAssociation(tx);
      if (p.type === 'annulation') {
        notification = await this.notifications.preparer(tx, {
          code: 'annulation_paiement',
          membreId: destinataire,
          variables: {
            'association.sigle': association.sigle,
            'paiement.numero_recu': p.origine_numero,
            'paiement.montant': montantSms(Number(p.montant)),
            motif: p.motif,
          },
          origineType: 'annulation_paiement',
          origineId: id,
          priorite: PRIORITE.prioritaire,
        });
      } else {
        const membres = await tx.query<{ membre_id: string }>(
          `SELECT DISTINCT membre_id FROM imputations_paiement WHERE paiement_id = $1`,
          [id],
        );
        notification = await this.preparerRecu(tx, {
          paiementId: id,
          numero: p.numero_recu,
          numeroProvisoire: p.numero_recu_provisoire,
          montant: Number(p.montant),
          date: jourGmt(p.date_paiement),
          destinataire,
          prenoms: p.prenoms ?? `famille ${p.famille_nom ?? ''}`,
          membreIds: membres.rows.map((m) => m.membre_id),
          cleDedup: null,
        });
      }
      if (notification.type !== 'creee') throw sansContact();
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'paiement.recu_renvoye',
        entiteType: 'paiement',
        entiteId: id,
        apres: { notificationId: notification.id },
      });
      return (await this.notifications.lire(tx, notification.id))!;
    });
    await this.notifications.publier([notification]);
    return dto;
  }
}

import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { compteCreationSchema, formatMontant, type CompteCreation } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { codeSql, invalide, referenceInvalide, VIOLATION_UNICITE } from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { valider } from '../../common/validation.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';

export interface Mouvement {
  compteId: string;
  exerciceId: string;
  sens: 'entree' | 'sortie';
  montant: number;
  /** Date métier `AAAA-MM-JJ`. */
  date: string;
  origineType: 'paiement' | 'annulation_paiement' | 'depense' | 'transfert' | 'ajustement';
  origineId: string;
  libelle: string;
  userId: string;
}

interface LigneCompte {
  id: string;
  type: 'caisse' | 'banque' | 'mobile_money';
  libelle: string;
  banque_ou_operateur: string | null;
  numero_compte: string | null;
  solde_initial: string;
  date_solde_initial: string;
  actif: boolean;
  solde: string;
}

function versDto(l: LigneCompte) {
  return {
    id: l.id,
    type: l.type,
    libelle: l.libelle,
    banqueOuOperateur: l.banque_ou_operateur,
    numeroCompte: l.numero_compte,
    soldeInitial: Number(l.solde_initial),
    dateSoldeInitial: l.date_solde_initial,
    actif: l.actif,
    solde: Number(l.solde),
  };
}

const SELECT_COMPTE = `
  SELECT c.id, c.type, c.libelle, c.banque_ou_operateur, c.numero_compte, c.solde_initial, c.date_solde_initial,
         c.actif, s.solde
    FROM comptes_tresorerie c JOIN v_soldes_comptes s ON s.compte_id = c.id`;

/**
 * Trésorerie (RG-TRE-001) : seul point d'écriture du journal `mouvements`, source unique des soldes. Sprint 4 :
 * comptes, mouvements des paiements et de leurs annulations ; transferts, ajustements et dépenses au sprint 6.
 */
@Injectable()
export class TresorerieService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * RG-EXE-002 : exercice ouvert contenant la date métier, sinon `EXERCICE_FERME`. Un exercice clôturé n'accepte
   * plus aucune écriture datée dans sa période, y compris les annulations (RG-EXE-003).
   */
  async exercicePour(tx: Tx, date: string, champ = 'datePaiement'): Promise<{ id: string; libelle: string }> {
    const r = await tx.query<{ id: string; libelle: string; statut: string }>(
      `SELECT id, libelle, statut FROM exercices WHERE $1::date BETWEEN date_debut AND date_fin`,
      [date],
    );
    const ex = r.rows[0];
    if (!ex || ex.statut !== 'ouvert') {
      const message = ex
        ? `L’exercice « ${ex.libelle} » est clôturé : aucune écriture datée du ${date}`
        : `Aucun exercice ne couvre le ${date} : créez l’exercice d’abord`;
      throw new ErreurMetier('EXERCICE_FERME', message, [{ champ, code: 'EXERCICE_FERME', message }]);
    }
    return ex;
  }

  /** Compte actif de l'association (verrouillé jusqu'à la fin de la transaction : soldes cohérents). */
  async compteActif(tx: Tx, compteId: string, champ = 'compteId'): Promise<{ id: string; libelle: string }> {
    const r = await tx.query<{ id: string; libelle: string; actif: boolean }>(
      `SELECT id, libelle, actif FROM comptes_tresorerie WHERE id = $1 FOR UPDATE`,
      [compteId],
    );
    const c = r.rows[0];
    if (!c) throw referenceInvalide(champ, 'Compte de trésorerie introuvable');
    if (!c.actif) throw invalide(champ, 'COMPTE_INACTIF', `Le compte « ${c.libelle} » est désactivé`);
    return c;
  }

  /** Écrit un mouvement ; une sortie ne rend jamais le solde négatif (RG-TRE-003 → `SOLDE_INSUFFISANT`). */
  async enregistrer(tx: Tx, m: Mouvement): Promise<void> {
    const r = await tx.query<{ libelle: string }>(
      `SELECT libelle FROM comptes_tresorerie WHERE id = $1 FOR UPDATE`,
      [m.compteId],
    );
    const compte = r.rows[0];
    if (!compte) throw referenceInvalide('compteId', 'Compte de trésorerie introuvable');
    if (m.sens === 'sortie') {
      const s = await tx.query<{ solde: string }>(`SELECT solde FROM v_soldes_comptes WHERE compte_id = $1`, [
        m.compteId,
      ]);
      const solde = Number(s.rows[0]?.solde ?? 0);
      if (solde < m.montant) {
        throw new ErreurMetier(
          'SOLDE_INSUFFISANT',
          `Le solde de « ${compte.libelle} » (${formatMontant(solde)}) ne couvre pas la sortie de ${formatMontant(m.montant)}`,
        );
      }
    }
    await tx.query(
      `INSERT INTO mouvements (association_id, compte_id, exercice_id, sens, montant, date_operation, origine_type,
                               origine_id, libelle, created_by)
       VALUES (app_association_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.compteId, m.exerciceId, m.sens, m.montant, m.date, m.origineType, m.origineId, m.libelle, m.userId],
    );
  }

  listerComptes() {
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneCompte>(`${SELECT_COMPTE} ORDER BY c.actif DESC, c.type, c.libelle`);
      return r.rows.map(versDto);
    });
  }

  /** RF-043 : création d'un compte ; le solde initial est la seule valeur de départ (pas de mouvement). */
  creerCompte(auth: AuthRequete, p: CompteCreation) {
    return this.db.tx(async (tx) => {
      let id: string;
      try {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO comptes_tresorerie (association_id, type, libelle, banque_ou_operateur, numero_compte,
                                           solde_initial, date_solde_initial)
           VALUES (app_association_id(), $1, $2, $3, $4, $5, coalesce($6::date, current_date)) RETURNING id`,
          [
            p.type,
            p.libelle,
            p.banqueOuOperateur ?? null,
            p.numeroCompte ?? null,
            p.soldeInitial ?? 0,
            p.dateSoldeInitial ?? null,
          ],
        );
        id = r.rows[0]!.id;
      } catch (e) {
        if (codeSql(e) === VIOLATION_UNICITE) {
          throw invalide('libelle', 'DOUBLON', `Un compte « ${p.libelle} » existe déjà`);
        }
        throw e;
      }
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'compte.cree',
        entiteType: 'compte',
        entiteId: id,
        apres: { ...p },
      });
      const r = await tx.query<LigneCompte>(`${SELECT_COMPTE} WHERE c.id = $1`, [id]);
      return versDto(r.rows[0]!);
    });
  }
}

/** Comptes de trésorerie et soldes (RF-043). */
@Controller('comptes')
export class ComptesController {
  constructor(private readonly tresorerie: TresorerieService) {}

  @Get()
  @Permission('tresorerie.lire')
  lister() {
    return this.tresorerie.listerComptes();
  }

  @Post()
  @Permission('tresorerie.transferer')
  creer(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.tresorerie.creerCompte(auth, valider(compteCreationSchema, corps));
  }
}

@Module({
  controllers: [ComptesController],
  providers: [TresorerieService],
  exports: [TresorerieService],
})
export class TresorerieModule {}

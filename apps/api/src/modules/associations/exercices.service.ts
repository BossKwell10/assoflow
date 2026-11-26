import { Injectable } from '@nestjs/common';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { codeSql, introuvable, invalide, VIOLATION_EXCLUSION } from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';

interface LigneExercice {
  id: string;
  libelle: string;
  date_debut: string;
  date_fin: string;
  statut: 'ouvert' | 'cloture';
  cloture_at: Date | null;
}

const SELECT_EXERCICE = `SELECT id, libelle, date_debut, date_fin, statut, cloture_at FROM exercices`;

const versDto = (l: LigneExercice) => ({
  id: l.id,
  libelle: l.libelle,
  dateDebut: l.date_debut,
  dateFin: l.date_fin,
  statut: l.statut,
  clotureAt: l.cloture_at?.toISOString() ?? null,
});

/** Exercices (E2-04, RF-012, RF-014, RF-ADM-022, RG-EXE-001 à 003). */
@Injectable()
export class ExercicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  lister() {
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneExercice>(`${SELECT_EXERCICE} ORDER BY date_debut DESC`);
      return r.rows.map(versDto);
    });
  }

  /** RG-EXE-001 : pas de chevauchement (vérifié ici pour un message clair, garanti par la contrainte d'exclusion). */
  async creer(auth: AuthRequete, p: { libelle: string; dateDebut: string; dateFin: string }) {
    const chevauchement = () =>
      invalide('dateDebut', 'CHEVAUCHEMENT', 'La période chevauche un exercice existant (RG-EXE-001)');
    try {
      return await this.db.tx(async (tx) => {
        const existant = await tx.query<{ libelle: string }>(
          `SELECT libelle FROM exercices
            WHERE daterange(date_debut, date_fin, '[]') && daterange($1::date, $2::date, '[]') LIMIT 1`,
          [p.dateDebut, p.dateFin],
        );
        if (existant.rows[0]) throw chevauchement();
        const r = await tx.query<LigneExercice>(
          `INSERT INTO exercices (association_id, libelle, date_debut, date_fin)
           VALUES (app_association_id(), $1, $2, $3)
           RETURNING id, libelle, date_debut, date_fin, statut, cloture_at`,
          [p.libelle, p.dateDebut, p.dateFin],
        );
        const ligne = r.rows[0]!;
        await this.audit.tracer(tx, {
          associationId: auth.associationId!,
          action: 'exercice.cree',
          entiteType: 'exercice',
          entiteId: ligne.id,
          apres: { libelle: p.libelle, dateDebut: p.dateDebut, dateFin: p.dateFin },
        });
        return versDto(ligne);
      });
    } catch (e) {
      // Deux créations concurrentes : la contrainte d'exclusion tranche.
      if (codeSql(e) === VIOLATION_EXCLUSION) throw chevauchement();
      throw e;
    }
  }

  /**
   * RG-EXE-003 : clôture refusée s'il reste des dépenses `soumise` ou `validee` datées dans l'exercice.
   * Après clôture, plus aucune écriture datée dans la période (contrôlé par les modules financiers, RG-EXE-002).
   */
  cloturer(auth: AuthRequete, id: string) {
    return this.db.tx(async (tx) => {
      const ex = await this.lireLigne(tx, id);
      if (ex.statut !== 'ouvert')
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Cet exercice est déjà clôturé');
      const enCours = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM depenses
          WHERE statut IN ('soumise', 'validee') AND (exercice_id = $1 OR date_depense BETWEEN $2 AND $3)`,
        [id, ex.date_debut, ex.date_fin],
      );
      const n = enCours.rows[0]!.n;
      if (n > 0) {
        throw new ErreurMetier(
          'DEPENSES_EN_COURS',
          `${n} dépense(s) soumise(s) ou validée(s) dans l’exercice « ${ex.libelle} » : validez, payez, rejetez ou annulez-les avant la clôture (RG-EXE-003)`,
        );
      }
      const r = await tx.query<LigneExercice>(
        `UPDATE exercices SET statut = 'cloture', cloture_at = now(), cloture_par = $2 WHERE id = $1
         RETURNING id, libelle, date_debut, date_fin, statut, cloture_at`,
        [id, auth.userId],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'exercice.cloture',
        entiteType: 'exercice',
        entiteId: id,
        avant: { statut: 'ouvert' },
        apres: { statut: 'cloture', libelle: ex.libelle },
      });
      return versDto(r.rows[0]!);
    });
  }

  private async lireLigne(tx: Tx, id: string): Promise<LigneExercice> {
    const r = await tx.query<LigneExercice>(`${SELECT_EXERCICE} WHERE id = $1 FOR UPDATE`, [id]);
    if (!r.rows[0]) throw introuvable('Exercice introuvable');
    return r.rows[0];
  }
}

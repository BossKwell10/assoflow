import { Injectable } from '@nestjs/common';
import { ROLES_SYSTEME } from '@assoflow/contracts';
import { randomUUID } from 'node:crypto';
import { contexteCourant } from '../../common/contexte.js';
import { DatabaseService } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { ComptesService } from '../auth/comptes.service.js';

export interface CreationAssociation {
  nom: string;
  village: string;
  region: string;
  sigle?: string;
  type?: 'association' | 'mutuelle_developpement' | 'mutuelle_sociale' | 'autre';
  moisDebutExercice?: number;
  /** Administrateur désigné : reçoit l'accès `president`. */
  president: { telephone: string; nom: string; prenoms: string };
  /** Auteur de la création (super-admin) ; `null` = système (seed, validation automatique). */
  acteurId?: string | null;
}

export interface AssociationCreee {
  associationId: string;
  presidentUserId: string;
  presidentAccesId: string;
  roles: Record<keyof typeof ROLES_SYSTEME, string>;
  exerciceId: string;
}

/** Catégories de dépense par défaut (RG-ASS-001). */
const CATEGORIES_DEPENSE = [
  { nature: 'fonctionnement', libelle: 'Fonctionnement' },
  { nature: 'projet', libelle: 'Projet' },
  { nature: 'aide_sociale', libelle: 'Aide sociale' },
  { nature: 'autre', libelle: 'Autre' },
] as const;

/** Exercice de 12 mois commençant au mois `moisDebut` et contenant `jour` (RG-EXE-001). */
export function exerciceCouvrant(
  jour: Date,
  moisDebut: number,
): { debut: string; fin: string; libelle: string } {
  const annee = jour.getUTCMonth() + 1 >= moisDebut ? jour.getUTCFullYear() : jour.getUTCFullYear() - 1;
  const debut = new Date(Date.UTC(annee, moisDebut - 1, 1));
  const fin = new Date(Date.UTC(annee + 1, moisDebut - 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    debut: iso(debut),
    fin: iso(fin),
    libelle: moisDebut === 1 ? `Exercice ${annee}` : `Exercice ${annee}-${annee + 1}`,
  };
}

@Injectable()
export class AssociationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly comptes: ComptesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * RG-ASS-001 : crée le tenant et, dans la même transaction, les 5 rôles système, l'accès `president`,
   * le compte `Caisse`, les catégories de dépense par défaut, la catégorie « Membre ordinaire » et
   * l'exercice couvrant la date du jour.
   */
  async creer(p: CreationAssociation): Promise<AssociationCreee> {
    const associationId = randomUUID();
    const moisDebut = p.moisDebutExercice ?? 1;
    const acteurId = p.acteurId ?? null;
    return this.db.tx(
      async (tx) => {
        await tx.query(
          `INSERT INTO associations (id, nom, sigle, type, village, region, mois_debut_exercice)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [associationId, p.nom, p.sigle ?? null, p.type ?? 'association', p.village, p.region, moisDebut],
        );
        const roles = {} as Record<keyof typeof ROLES_SYSTEME, string>;
        for (const [code, role] of Object.entries(ROLES_SYSTEME) as [
          keyof typeof ROLES_SYSTEME,
          (typeof ROLES_SYSTEME)[keyof typeof ROLES_SYSTEME],
        ][]) {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO roles (association_id, code, libelle, permissions, systeme)
             VALUES ($1, $2, $3, $4, true) RETURNING id`,
            [associationId, code, role.libelle, role.permissions],
          );
          roles[code] = r.rows[0]!.id;
        }
        const president = await this.comptes.trouverOuCreer(tx, p.president);
        const acces = await tx.query<{ id: string }>(
          `INSERT INTO acces_association (association_id, user_id, role_id, mandat_debut)
           VALUES ($1, $2, $3, current_date) RETURNING id`,
          [associationId, president.id, roles.president],
        );
        await tx.query(
          `INSERT INTO comptes_tresorerie (association_id, type, libelle) VALUES ($1, 'caisse', 'Caisse')`,
          [associationId],
        );
        for (const c of CATEGORIES_DEPENSE) {
          await tx.query(
            `INSERT INTO categories_depense (association_id, nature, libelle) VALUES ($1, $2, $3)`,
            [associationId, c.nature, c.libelle],
          );
        }
        await tx.query(
          `INSERT INTO categories_membres (association_id, libelle) VALUES ($1, 'Membre ordinaire')`,
          [associationId],
        );
        const ex = exerciceCouvrant(new Date(), moisDebut);
        const exercice = await tx.query<{ id: string }>(
          `INSERT INTO exercices (association_id, libelle, date_debut, date_fin) VALUES ($1, $2, $3, $4) RETURNING id`,
          [associationId, ex.libelle, ex.debut, ex.fin],
        );
        await this.audit.tracer(tx, {
          associationId,
          acteurId,
          acteurType: acteurId ? 'utilisateur' : 'systeme',
          action: 'association.creee',
          entiteType: 'association',
          entiteId: associationId,
          apres: { nom: p.nom, region: p.region, presidentAccesId: acces.rows[0]!.id },
        });
        return {
          associationId,
          presidentUserId: president.id,
          presidentAccesId: acces.rows[0]!.id,
          roles,
          exerciceId: exercice.rows[0]!.id,
        };
      },
      {
        requestId: contexteCourant()?.requestId ?? 'creation-association',
        associationId,
        userId: acteurId ?? undefined,
      },
    );
  }
}

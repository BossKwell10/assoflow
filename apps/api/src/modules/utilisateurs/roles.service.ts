import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS_RESERVEES_PRESIDENT,
  ROLES_SYSTEME,
  estPermission,
  type Permission,
} from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { PermissionsService } from '../../common/auth/permissions.service.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';

export interface RoleDto {
  id: string;
  code: string;
  libelle: string;
  permissions: string[];
  systeme: boolean;
}

interface LigneRole {
  id: string;
  code: string;
  libelle: string;
  permissions: string[];
  systeme: boolean;
}

const versDto = (r: LigneRole): RoleDto => ({
  id: r.id,
  code: r.code,
  libelle: r.libelle,
  permissions: r.permissions,
  systeme: r.systeme,
});

/** Rôles et matrice de permissions (E2-07, RF-ADM-012, docs/04 §4). */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  async lister(): Promise<RoleDto[]> {
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneRole>(
        `SELECT id, code, libelle, permissions, systeme FROM roles ORDER BY systeme DESC, libelle`,
      );
      return r.rows.map(versDto);
    });
  }

  async lire(tx: Tx, id: string): Promise<LigneRole | null> {
    const r = await tx.query<LigneRole>(
      `SELECT id, code, libelle, permissions, systeme FROM roles WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async creer(
    auth: AuthRequete,
    p: { code: string; libelle: string; permissions: string[] },
  ): Promise<RoleDto> {
    if (p.code in ROLES_SYSTEME) {
      throw new ErreurMetier('VALIDATION', 'Code réservé à un rôle système', [
        { champ: 'code', code: 'CODE_RESERVE', message: 'Ce code est réservé à un rôle système' },
      ]);
    }
    const permissions = this.verifierPermissions(p.permissions, null);
    const role = await this.db.tx(async (tx) => {
      const existe = await tx.query(`SELECT 1 FROM roles WHERE code = $1`, [p.code]);
      if ((existe.rowCount ?? 0) > 0) {
        throw new ErreurMetier('VALIDATION', 'Code déjà utilisé', [
          { champ: 'code', code: 'CODE_DEJA_UTILISE', message: 'Un rôle porte déjà ce code' },
        ]);
      }
      const r = await tx.query<LigneRole>(
        `INSERT INTO roles (association_id, code, libelle, permissions, systeme)
         VALUES ($1, $2, $3, $4, false) RETURNING id, code, libelle, permissions, systeme`,
        [auth.associationId, p.code, p.libelle, permissions],
      );
      const cree = r.rows[0]!;
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'role.cree',
        entiteType: 'role',
        entiteId: cree.id,
        apres: { code: cree.code, libelle: cree.libelle, permissions },
      });
      return cree;
    });
    return versDto(role);
  }

  async modifier(
    auth: AuthRequete,
    id: string,
    p: { code?: string; libelle?: string; permissions?: string[] },
  ): Promise<RoleDto> {
    const role = await this.db.tx(async (tx) => {
      const avant = await this.lire(tx, id);
      if (!avant) throw new ErreurMetier('INTROUVABLE', 'Rôle introuvable');
      if (p.code !== undefined && p.code !== avant.code) {
        if (avant.systeme || p.code in ROLES_SYSTEME) {
          throw new ErreurMetier('VALIDATION', "Le code d'un rôle système ne change pas", [
            { champ: 'code', code: 'CODE_RESERVE', message: "Le code d'un rôle système ne change pas" },
          ]);
        }
        const existe = await tx.query(`SELECT 1 FROM roles WHERE code = $1 AND id <> $2`, [p.code, id]);
        if ((existe.rowCount ?? 0) > 0) {
          throw new ErreurMetier('VALIDATION', 'Code déjà utilisé', [
            { champ: 'code', code: 'CODE_DEJA_UTILISE', message: 'Un rôle porte déjà ce code' },
          ]);
        }
      }
      const permissions =
        p.permissions === undefined
          ? avant.permissions
          : this.verifierPermissions(
              p.permissions,
              avant.systeme ? (avant.code as keyof typeof ROLES_SYSTEME) : null,
            );
      const r = await tx.query<LigneRole>(
        `UPDATE roles SET code = $2, libelle = $3, permissions = $4 WHERE id = $1
         RETURNING id, code, libelle, permissions, systeme`,
        [id, p.code ?? avant.code, p.libelle ?? avant.libelle, permissions],
      );
      const apres = r.rows[0]!;
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'role.modifie',
        entiteType: 'role',
        entiteId: id,
        avant: { code: avant.code, libelle: avant.libelle, permissions: avant.permissions },
        apres: { code: apres.code, libelle: apres.libelle, permissions: apres.permissions },
      });
      return apres;
    });
    // Toute modification de rôle invalide les permissions en cache du tenant (docs/04 §3).
    await this.permissions.invalider(auth.associationId!);
    return versDto(role);
  }

  async supprimer(auth: AuthRequete, id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const role = await this.lire(tx, id);
      if (!role) throw new ErreurMetier('INTROUVABLE', 'Rôle introuvable');
      if (role.systeme)
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Un rôle système ne peut pas être supprimé');
      const utilise = await tx.query(`SELECT 1 FROM acces_association WHERE role_id = $1 LIMIT 1`, [id]);
      if ((utilise.rowCount ?? 0) > 0) {
        throw new ErreurMetier(
          'ETAT_INCOMPATIBLE',
          'Ce rôle est attribué (ou l’a été) : il ne peut pas être supprimé',
        );
      }
      await tx.query(`DELETE FROM roles WHERE id = $1`, [id]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'role.supprime',
        entiteType: 'role',
        entiteId: id,
        avant: { code: role.code, libelle: role.libelle, permissions: role.permissions },
      });
    });
    await this.permissions.invalider(auth.associationId!);
  }

  /**
   * docs/04 §4 : permissions du catalogue uniquement ; `utilisateur.gerer`, `role.gerer`, `association.modifier`
   * réservées au rôle système président ; un rôle système garde au moins ses permissions livrées
   * (on peut en ajouter, pas en retirer : garde-fou contre le verrouillage de l'association).
   */
  private verifierPermissions(
    demandees: string[],
    roleSysteme: keyof typeof ROLES_SYSTEME | null,
  ): Permission[] {
    const erreurs: { champ: string; code: string; message: string }[] = [];
    const uniques = [...new Set(demandees)];
    uniques.forEach((code, i) => {
      if (!estPermission(code)) {
        erreurs.push({
          champ: `permissions.${i}`,
          code: 'PERMISSION_INCONNUE',
          message: `Permission inconnue : ${code}`,
        });
      } else if (roleSysteme !== 'president' && PERMISSIONS_RESERVEES_PRESIDENT.includes(code)) {
        erreurs.push({
          champ: `permissions.${i}`,
          code: 'PERMISSION_RESERVEE',
          message: `${code} est réservée au rôle président`,
        });
      }
    });
    if (roleSysteme) {
      for (const p of ROLES_SYSTEME[roleSysteme].permissions) {
        if (!uniques.includes(p)) {
          erreurs.push({
            champ: 'permissions',
            code: 'PERMISSION_SYSTEME_OBLIGATOIRE',
            message: `${p} ne peut pas être retirée d'un rôle système`,
          });
        }
      }
    }
    if (erreurs.length > 0) throw new ErreurMetier('VALIDATION', 'Permissions invalides', erreurs);
    return (uniques as Permission[]).sort();
  }
}

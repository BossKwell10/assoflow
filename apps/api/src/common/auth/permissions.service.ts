import { Inject, Injectable } from '@nestjs/common';
import {
  CACHE_PERMISSIONS,
  type AccesEffectif,
  type CachePermissions,
} from '../../infra/cache-permissions.js';
import { DatabaseService } from '../../infra/database.js';

/**
 * Chargement des permissions effectives de (aid, sub) : accès actif au mandat en cours, permissions du rôle
 * et délégations actives (docs/04 §3-5, RF-ADM-012, RF-ADM-032). Mis en cache 60 s, invalidé explicitement.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_PERMISSIONS) private readonly cache: CachePermissions,
  ) {}

  async charger(aid: string, sub: string, requestId: string): Promise<AccesEffectif | null> {
    const enCache = await this.cache.lire(aid, sub);
    if (enCache !== undefined) return enCache;
    const acces = await this.db.tx(
      async (tx) => {
        const r = await tx.query<{ acces_id: string; role_code: string; permissions: string[] }>(
          `SELECT a.id AS acces_id, r.code AS role_code,
                  ARRAY(SELECT DISTINCT p FROM unnest(r.permissions || coalesce((
                          SELECT array_agg(d.permission) FROM delegations d
                           WHERE d.delegataire_id = a.user_id AND d.annulee_at IS NULL
                             AND d.debut <= now() AND d.fin > now()), '{}')) AS p ORDER BY p) AS permissions
             FROM acces_association a
             JOIN roles r ON r.id = a.role_id
             JOIN associations s ON s.id = a.association_id
            WHERE a.user_id = $1 AND a.statut = 'actif' AND s.statut <> 'archivee'
              AND (a.mandat_debut IS NULL OR a.mandat_debut <= current_date)
              AND (a.mandat_fin IS NULL OR a.mandat_fin >= current_date)`,
          [sub],
        );
        const ligne = r.rows[0];
        return ligne
          ? { accesId: ligne.acces_id, roleCode: ligne.role_code, permissions: ligne.permissions }
          : null;
      },
      { requestId, associationId: aid, userId: sub },
    );
    await this.cache.ecrire(aid, sub, acces);
    return acces;
  }

  invalider(aid: string, sub?: string): Promise<void> {
    return this.cache.invalider(aid, sub);
  }
}

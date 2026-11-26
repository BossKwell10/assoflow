import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Permission as CodePermission, PermissionPlateforme } from '@assoflow/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthRequete } from './auth-requete.js';

export const CLE_PUBLIC = 'assoflow:public';
export const CLE_PERMISSION = 'assoflow:permission';
export const CLE_HORS_TENANT = 'assoflow:hors-tenant';
export const CLE_INTERMEDIAIRE = 'assoflow:intermediaire';

/** Route publique : aucun jeton exigé (docs/07 §7). */
export const Public = () => SetMetadata(CLE_PUBLIC, true);

/** Permission requise (docs/04 §4). Une permission `pf.*` exige un rôle plateforme. */
export const Permission = (code: CodePermission | PermissionPlateforme) => SetMetadata(CLE_PERMISSION, code);

/**
 * Route authentifiée qui ne dépend pas de l'association active (`/auth/moi`, `/auth/contexte`…) :
 * l'accès au tenant n'est pas vérifié, et la RLS n'expose aucune donnée tenant.
 */
export const HorsTenant = () => SetMetadata(CLE_HORS_TENANT, true);

/**
 * Route qui accepte aussi le jeton intermédiaire `totp_activation` (activation TOTP obligatoire
 * avant la première connexion console d'un membre du bureau, docs/04 §2.2).
 */
export const AccepteJetonIntermediaire = () => SetMetadata(CLE_INTERMEDIAIRE, true);

/** Injecte l'identité authentifiée (posée par `AuthGuard`). */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthRequete => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest & { auth?: AuthRequete }>();
  if (!req.auth) throw new Error('Route sans authentification : @Auth() indisponible');
  return req.auth;
});

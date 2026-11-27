import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_ROLES_PLATEFORME } from '@assoflow/contracts';
import type { FastifyRequest } from 'fastify';
import type { ContexteRequete } from '../contexte.js';
import { ErreurMetier } from '../erreur-metier.js';
import { JetonsService } from '../../modules/auth/jetons.service.js';
import { SessionsService } from '../../modules/auth/sessions.service.js';
import type { AuthRequete } from './auth-requete.js';
import { CLE_HORS_TENANT, CLE_INTERMEDIAIRE, CLE_PERMISSION, CLE_PUBLIC } from './decorateurs.js';
import { PermissionsService } from './permissions.service.js';

type Requete = FastifyRequest & { auth?: AuthRequete };

/**
 * Guard global (E2-01) : authentification Bearer, vérification de la session, de l'accès au tenant
 * actif et de la permission déclarée par `@Permission()`. Les barrières 1 et 2 de docs/04 §5.
 * Le contexte calculé est posé dans `contexteStorage` par `ContexteInterceptor` (via `run()`).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jetons: JetonsService,
    private readonly sessions: SessionsService,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const cibles = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(CLE_PUBLIC, cibles)) return true;
    const req = ctx.switchToHttp().getRequest<Requete>();
    const base: ContexteRequete = { requestId: String(req.id), ip: req.ip };

    const entete = req.headers.authorization;
    const jeton = entete?.startsWith('Bearer ') ? entete.slice(7).trim() : undefined;
    if (!jeton) throw new ErreurMetier('NON_AUTHENTIFIE', 'Authentification requise');

    const accepteIntermediaire =
      this.reflector.getAllAndOverride<boolean>(CLE_INTERMEDIAIRE, cibles) ?? false;
    const verifie = await this.jetons.verifierBearer(jeton, accepteIntermediaire);

    if (verifie.type === 'intermediaire') {
      // Seule l'activation TOTP obligatoire est permise avec ce jeton.
      if (verifie.claims.etp !== 'totp_activation') {
        throw new ErreurMetier('NON_AUTHENTIFIE', 'Jeton intermédiaire non valable pour cette opération');
      }
      const contexte: ContexteRequete = { ...base, userId: verifie.claims.sub };
      req.auth = {
        type: 'intermediaire',
        userId: verifie.claims.sub,
        canal: verifie.claims.can,
        permissions: [],
        contexte,
      };
      return true;
    }

    const c = verifie.claims;

    const contexte: ContexteRequete = {
      ...base,
      userId: c.sub,
      associationId: c.aid,
      rolePlateforme: c.pf,
    };
    const auth: AuthRequete = {
      type: 'acces',
      userId: c.sub,
      canal: c.can,
      sessionId: c.sid,
      associationId: c.aid,
      appareilId: c.dev,
      rolePlateforme: c.pf,
      permissions: c.pf ? PERMISSIONS_ROLES_PLATEFORME[c.pf] : [],
      contexte,
    };
    req.auth = auth;

    const requise = this.reflector.getAllAndOverride<string | undefined>(CLE_PERMISSION, cibles);
    const horsTenant = this.reflector.getAllAndOverride<boolean>(CLE_HORS_TENANT, cibles) ?? false;

    if (requise?.startsWith('pf.')) {
      if (!auth.permissions.includes(requise)) {
        throw new ErreurMetier('PERMISSION_REFUSEE', 'Permission plateforme requise');
      }
    } else if (c.aid && !horsTenant) {
      // Barrière 2 (docs/04 §5) : accès actif et mandat en cours, sinon 403 ACCES_REVOQUE. Vérifiée avant
      // la session : un accès révoqué (dont les sessions le sont aussi) reçoit un motif explicite.
      const acces = await this.permissions.charger(c.aid, c.sub, base.requestId);
      if (!acces) throw new ErreurMetier('ACCES_REVOQUE', "Votre accès à cette association n'est plus actif");
      auth.permissions = acces.permissions;
      if (requise && !acces.permissions.includes(requise)) {
        throw new ErreurMetier('PERMISSION_REFUSEE', `Permission requise : ${requise}`);
      }
    } else if (requise) {
      throw new ErreurMetier('PERMISSION_REFUSEE', 'Aucune association active : choisissez un contexte');
    }
    // Session non révoquée (déconnexion, réutilisation de refresh) et compte actif.
    // Appareil révoqué (docs/05 §8) : 401 APPAREIL_REVOQUE avant tout autre motif (ses sessions le sont aussi).
    if (c.dev && c.aid) await this.sessions.verifierAppareil(c.dev, contexte);
    await this.sessions.verifierActive(c.sid, c.sub);
    return true;
  }
}

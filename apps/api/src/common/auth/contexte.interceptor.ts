import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { contexteStorage } from '../contexte.js';
import type { AuthRequete } from './auth-requete.js';

/**
 * Exécute le contrôleur dans `contexteStorage.run()` avec le contexte calculé par `AuthGuard`
 * (tenant, utilisateur, rôle plateforme) : `DatabaseService.tx()` le lit pour poser les `SET LOCAL`.
 * Un guard ne peut pas envelopper l'exécution du contrôleur ; l'intercepteur le fait juste après lui.
 */
@Injectable()
export class ContexteInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { auth?: AuthRequete }>();
    // Routes publiques : au moins requestId et IP (audit des connexions).
    const contexte = req.auth?.contexte ?? { requestId: String(req.id), ip: req.ip };
    return new Observable((abonne) => {
      const abonnement = contexteStorage.run({ ...contexte }, () => next.handle().subscribe(abonne));
      return () => abonnement.unsubscribe();
    });
  }
}

import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Canal } from '@assoflow/contracts';
import type { FastifyReply } from 'fastify';
import { map, type Observable } from 'rxjs';
import { ErreurMetier } from './erreur-metier.js';

/**
 * Concurrence optimiste (docs/07 §5) : `ETag` sur les lectures, `If-Match` sur les `PATCH`.
 *
 * Usage : le service renvoie `avecEtag(dto, version)` ; `EtagInterceptor` (global) pose l'en-tête `ETag`
 * et le champ `etag` du corps porte la même valeur (le client généré de la console ne lit pas les en-têtes).
 * Avant d'écrire, le service relit la ligne `FOR UPDATE` puis appelle `verifierIfMatch()`.
 */
const ETAG = Symbol('etag');

/** Valeur d'ETag forte pour une version (sync_version, horodatage…) : `"12"`. */
export function etagDe(version: string | number | bigint): string {
  return `"${String(version)}"`;
}

export function avecEtag<T extends object>(dto: T, version: string | number | bigint): T & { etag: string } {
  const etag = etagDe(version);
  const resultat = { ...dto, etag };
  Object.defineProperty(resultat, ETAG, { value: etag, enumerable: false });
  return resultat;
}

/**
 * - `If-Match` absent : refusé depuis la console (`428 PRECONDITION_REQUISE`), toléré depuis le mobile
 *   (la synchronisation gère ses conflits, docs/05) ;
 * - `*` : accepté ; sinon une des valeurs (comparaison faible : `W/` ignoré) doit égaler l'ETag courant,
 *   sinon `412 PRECONDITION_ECHOUEE`.
 */
export function verifierIfMatch(ifMatch: string | undefined, etagCourant: string, canal: Canal): void {
  const valeur = ifMatch?.trim();
  if (!valeur) {
    if (canal === 'console') {
      throw new ErreurMetier(
        'PRECONDITION_REQUISE',
        'En-tête If-Match obligatoire : relisez la fiche avant de la modifier',
      );
    }
    return;
  }
  if (valeur === '*') return;
  const normaliser = (v: string) => v.trim().replace(/^W\//, '');
  const courant = normaliser(etagCourant);
  if (!valeur.split(',').some((v) => normaliser(v) === courant)) {
    throw new ErreurMetier(
      'PRECONDITION_ECHOUEE',
      'Cette fiche a été modifiée par quelqu’un d’autre entre-temps : rechargez-la puis recommencez',
    );
  }
}

/** Pose l'en-tête `ETag` quand le contrôleur renvoie un objet construit par `avecEtag()`. */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const reply = ctx.switchToHttp().getResponse<FastifyReply>();
    return next.handle().pipe(
      map((corps: unknown) => {
        const etag = corps && typeof corps === 'object' ? (corps as { [ETAG]?: string })[ETAG] : undefined;
        if (etag) void reply.header('etag', etag);
        return corps;
      }),
    );
  }
}

import { createHash } from 'node:crypto';
import { ErreurMetier } from './erreur-metier.js';

/** Code SQLSTATE d'une erreur PostgreSQL (`pg`), ou `undefined`. */
export function codeSql(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

export const VIOLATION_UNICITE = '23505';
export const VIOLATION_EXCLUSION = '23P01';

/** Empreinte stable (clés triées) d'un corps de requête validé, pour l'idempotence des créations à id client. */
export function empreinte(valeur: unknown): string {
  const trier = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(trier)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, trier(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(trier(valeur)))
    .digest('hex');
}

export function conflitIdempotence(): ErreurMetier {
  return new ErreurMetier(
    'CONFLIT_IDEMPOTENCE',
    'Cet identifiant a déjà servi pour une autre création : générez un nouvel identifiant',
  );
}

/** Erreur `422 REFERENCE_INVALIDE` sur un champ (ressource référencée introuvable sous RLS, docs/04 §5). */
export function referenceInvalide(champ: string, message: string): ErreurMetier {
  return new ErreurMetier('REFERENCE_INVALIDE', message, [{ champ, code: 'REFERENCE_INVALIDE', message }]);
}

export function invalide(champ: string, code: string, message: string): ErreurMetier {
  return new ErreurMetier('VALIDATION', message, [{ champ, code, message }]);
}

export function introuvable(message = 'Ressource introuvable'): ErreurMetier {
  return new ErreurMetier('INTROUVABLE', message);
}

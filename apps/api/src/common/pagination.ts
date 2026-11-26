import { ErreurMetier } from './erreur-metier.js';

/** Pagination par curseur (docs/07 §3) : curseur opaque = position (horodatage texte PostgreSQL, id). */
export interface Position {
  ts: string;
  id: string;
}

export function encoderCurseur(p: Position): string {
  return Buffer.from(JSON.stringify([p.ts, p.id])).toString('base64url');
}

export function decoderCurseur(curseur: string | undefined): Position | null {
  if (!curseur) return null;
  try {
    const [ts, id] = JSON.parse(Buffer.from(curseur, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof ts === 'string' && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return { ts, id };
  } catch {
    // curseur illisible : traité ci-dessous
  }
  throw new ErreurMetier('VALIDATION', 'Curseur invalide', [
    { champ: 'curseur', code: 'INVALIDE', message: 'Curseur invalide' },
  ]);
}

export function lireLimite(brut: string | undefined, defaut = 50, max = 200): number {
  if (brut === undefined) return defaut;
  const n = Number(brut);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ErreurMetier('VALIDATION', 'Limite invalide', [
      { champ: 'limite', code: 'INVALIDE', message: `Entier entre 1 et ${max} attendu` },
    ]);
  }
  return n;
}

/**
 * Curseur de tri générique (keyset) : `[tri, valeur de la clé de tri, id]`. Le tri est inclus pour refuser
 * un curseur obtenu avec un autre ordre.
 */
export interface PositionTri {
  tri: string;
  valeur: string;
  id: string;
}

export function encoderCurseurTri(p: PositionTri): string {
  return Buffer.from(JSON.stringify([p.tri, p.valeur, p.id])).toString('base64url');
}

export function decoderCurseurTri(curseur: string | undefined, tri: string): PositionTri | null {
  if (!curseur) return null;
  try {
    const [t, valeur, id] = JSON.parse(Buffer.from(curseur, 'base64url').toString('utf8')) as unknown[];
    if (t === tri && typeof valeur === 'string' && typeof id === 'string' && id.length <= 64) {
      return { tri, valeur, id };
    }
  } catch {
    // curseur illisible : traité ci-dessous
  }
  throw new ErreurMetier('VALIDATION', 'Curseur invalide', [
    { champ: 'curseur', code: 'INVALIDE', message: 'Curseur invalide' },
  ]);
}

/** `?total=true` (docs/07 §3) : le total n'est calculé que sur demande. */
export function lireBooleen(brut: string | undefined, champ: string): boolean | undefined {
  if (brut === undefined) return undefined;
  if (brut === 'true') return true;
  if (brut === 'false') return false;
  throw new ErreurMetier('VALIDATION', 'Booléen attendu', [
    { champ, code: 'INVALIDE', message: 'true ou false attendu' },
  ]);
}

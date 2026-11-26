import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 poivré (OTP, codes de secours) : le code n'est jamais stocké en clair (docs/02 §3.1). */
export function hmacPoivre(valeur: string, poivre: Buffer): string {
  return createHmac('sha256', poivre).update(valeur).digest('hex');
}

/** Comparaison à temps constant de deux empreintes hexadécimales. */
export function egalEnTempsConstant(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Code OTP à 6 chiffres, tirage uniforme. */
export function genererCodeOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Jeton opaque (refresh token) : 256 bits en base64url. */
export function genererJetonOpaque(): string {
  return randomBytes(32).toString('base64url');
}

/** Empreinte SHA-256 d'un refresh token (seule forme stockée, `sessions.refresh_hash`). */
export function empreinteJeton(jeton: string): string {
  return createHash('sha256').update(jeton).digest('hex');
}

const ALPHABET_SECOURS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 10 codes de secours `xxxxx-xxxxx` (≈ 49 bits chacun), à usage unique. */
export function genererCodesSecours(nombre = 10): string[] {
  return Array.from({ length: nombre }, () => {
    let c = '';
    for (let i = 0; i < 10; i++) c += ALPHABET_SECOURS[randomInt(0, ALPHABET_SECOURS.length)];
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}

export function normaliserCodeSecours(code: string): string {
  const c = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

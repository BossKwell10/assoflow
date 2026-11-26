import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP RFC 6238 (HMAC-SHA1, 6 chiffres, pas de 30 s) — RF-003. */

export const TOTP_PAS_SECONDES = 30;
export const TOTP_CHIFFRES = 6;
const ALPHABET_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encoderBase32(octets: Buffer): string {
  let bits = 0;
  let valeur = 0;
  let sortie = '';
  for (const octet of octets) {
    valeur = (valeur << 8) | octet;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET_BASE32[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += ALPHABET_BASE32[(valeur << (5 - bits)) & 31];
  return sortie;
}

export function decoderBase32(texte: string): Buffer {
  const propre = texte.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let valeur = 0;
  const octets: number[] = [];
  for (const c of propre) {
    const i = ALPHABET_BASE32.indexOf(c);
    if (i < 0) throw new Error('Base32 invalide');
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

/** Secret de 160 bits (recommandation RFC 4226). */
export function genererSecretTotp(): Buffer {
  return randomBytes(20);
}

/** HOTP (RFC 4226) pour un compteur donné. */
export function hotp(secret: Buffer, compteur: number, chiffres = TOTP_CHIFFRES): string {
  const tampon = Buffer.alloc(8);
  tampon.writeBigUInt64BE(BigInt(compteur));
  const hmac = createHmac('sha1', secret).update(tampon).digest();
  const decalage = hmac[hmac.length - 1]! & 0x0f;
  const binaire =
    ((hmac[decalage]! & 0x7f) << 24) |
    (hmac[decalage + 1]! << 16) |
    (hmac[decalage + 2]! << 8) |
    hmac[decalage + 3]!;
  return String(binaire % 10 ** chiffres).padStart(chiffres, '0');
}

export function pasCourant(instantMs = Date.now()): number {
  return Math.floor(instantMs / 1000 / TOTP_PAS_SECONDES);
}

export function totp(secret: Buffer, instantMs = Date.now(), chiffres = TOTP_CHIFFRES): string {
  return hotp(secret, pasCourant(instantMs), chiffres);
}

/**
 * Vérifie un code avec une tolérance de ± `fenetre` pas (dérive d'horloge).
 * Renvoie le pas accepté (pour l'anti-rejeu) ou `null`. Un pas ≤ `dernierPas` est refusé.
 */
export function verifierTotp(
  secret: Buffer,
  code: string,
  options: { instantMs?: number; fenetre?: number; dernierPas?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const pas = pasCourant(options.instantMs ?? Date.now());
  const fenetre = options.fenetre ?? 1;
  for (let d = -fenetre; d <= fenetre; d++) {
    const candidat = pas + d;
    if (options.dernierPas != null && candidat <= options.dernierPas) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, candidat)), Buffer.from(code))) return candidat;
  }
  return null;
}

/** URL `otpauth://` pour l'application d'authentification (QR code affiché par la console). */
export function urlOtpauth(secret: Buffer, compte: string, emetteur = 'AssoFlow'): string {
  const libelle = encodeURIComponent(`${emetteur}:${compte}`);
  const params = new URLSearchParams({
    secret: encoderBase32(secret),
    issuer: emetteur,
    algorithm: 'SHA1',
    digits: String(TOTP_CHIFFRES),
    period: String(TOTP_PAS_SECONDES),
  });
  return `otpauth://totp/${libelle}?${params.toString()}`;
}

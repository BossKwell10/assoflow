import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Chiffrement applicatif AES-256-GCM des champs sensibles (docs/04 §8) : `iv (12) | tag (16) | chiffré`.
 */
export function chiffrer(clair: Buffer, cle: Buffer): Buffer {
  const iv = randomBytes(12);
  const chiffreur = createCipheriv('aes-256-gcm', cle, iv);
  const chiffre = Buffer.concat([chiffreur.update(clair), chiffreur.final()]);
  return Buffer.concat([iv, chiffreur.getAuthTag(), chiffre]);
}

export function dechiffrer(donnees: Buffer, cle: Buffer): Buffer {
  const iv = donnees.subarray(0, 12);
  const tag = donnees.subarray(12, 28);
  const dechiffreur = createDecipheriv('aes-256-gcm', cle, iv);
  dechiffreur.setAuthTag(tag);
  return Buffer.concat([dechiffreur.update(donnees.subarray(28)), dechiffreur.final()]);
}

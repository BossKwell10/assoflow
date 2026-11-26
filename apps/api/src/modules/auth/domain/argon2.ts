import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** argon2id, m = 64 Mo, t = 3, p = 1 (RF-SUP-053, docs/04 §2.4). `Algorithm` est un const enum : 2 = Argon2id. */
export const OPTIONS_ARGON2 = { algorithm: 2 as Algorithm, memoryCost: 65_536, timeCost: 3, parallelism: 1 };

export function hacherMotDePasse(motDePasse: string): Promise<string> {
  return hash(motDePasse, OPTIONS_ARGON2);
}

export function verifierMotDePasseHache(empreinte: string, motDePasse: string): Promise<boolean> {
  return verify(empreinte, motDePasse).catch(() => false);
}

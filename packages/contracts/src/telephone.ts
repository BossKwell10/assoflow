import { z } from 'zod';

/** Téléphone au format E.164. */
export const telephoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Téléphone au format international attendu');

/**
 * Normalise une saisie en E.164. Les numéros ivoiriens à 10 chiffres (07…, 05…, 01…, 27…)
 * reçoivent le préfixe +225 (RG-MBR-007).
 */
export function normaliserTelephone(saisie: string, indicatifDefaut = '225'): string {
  let t = saisie.replace(/[\s.\-()]/g, '');
  if (t.startsWith('00')) t = `+${t.slice(2)}`;
  if (!t.startsWith('+')) t = `+${indicatifDefaut}${t}`;
  return telephoneSchema.parse(t);
}

/** Masque un téléphone pour les logs et l'affichage restreint : +225 07 •• •• 41 18. */
export function masquerTelephone(e164: string): string {
  const fin = e164.slice(-4);
  return `${e164.slice(0, 4)} ${e164.slice(4, 6)} •• •• ${fin.slice(0, 2)} ${fin.slice(2)}`;
}

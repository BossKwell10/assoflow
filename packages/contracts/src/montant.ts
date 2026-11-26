import { z } from 'zod';

/** Montant en francs CFA (XOF), entier positif ou nul (D-007). */
export const montantSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Montant = z.infer<typeof montantSchema>;

/** RG-COT-031 : bornes d'un paiement. */
export const PAIEMENT_MAX = 5_000_000;
export const PAIEMENT_CONFIRMATION_AU_DELA = 500_000;

/** Lit une saisie utilisateur (« 25 000 », « 25000 ») en entier FCFA. Refuse toute décimale. */
export function parseMontant(saisie: string): Montant {
  const nettoye = saisie.replace(/[\s\u00a0\u202f]/g, '');
  if (!/^\d+$/.test(nettoye)) throw new Error(`Montant invalide : « ${saisie} »`);
  return montantSchema.parse(Number(nettoye));
}

/** Formate un montant : 25000 → « 25 000 FCFA » (espace fine insécable des milliers). */
export function formatMontant(montant: number, avecDevise = true): string {
  const signe = montant < 0 ? '−' : '';
  const corps = Math.abs(montant)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return `${signe}${corps}${avecDevise ? '\u00a0FCFA' : ''}`;
}

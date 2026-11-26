/** Verrouillage de compte (RF-005, docs/04 §2.3). */

export const ECHECS_AVANT_VERROUILLAGE = 5;
const BASE_MS = 15 * 60_000;
const MAX_MS = 24 * 3_600_000;
const FENETRE_MS = 24 * 3_600_000;

/**
 * Calcule le verrouillage à appliquer au 5e échec consécutif : 15 min, doublé pour chaque
 * verrouillage précédent dans les 24 h, plafonné à 24 h.
 */
export function calculerVerrouillage(
  maintenant: Date,
  precedent: { nombre: number; dernier: Date | null },
): { jusqua: Date; nombre: number } {
  const recent =
    precedent.dernier !== null && maintenant.getTime() - precedent.dernier.getTime() < FENETRE_MS;
  const nombre = recent ? precedent.nombre + 1 : 1;
  const duree = Math.min(BASE_MS * 2 ** (nombre - 1), MAX_MS);
  return { jusqua: new Date(maintenant.getTime() + duree), nombre };
}

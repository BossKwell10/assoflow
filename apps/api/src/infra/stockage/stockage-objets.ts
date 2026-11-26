/**
 * Stockage objet (logos, photos de membres ; plus tard pièces jointes, exports). Deux implémentations :
 * S3 compatible (production, docs/01 §6) et disque local (développement, tests). Aucune donnée binaire en base :
 * seule la clé est conservée (`associations.logo_cle`, `membres.photo_cle`).
 */
export interface StockageObjets {
  deposer(cle: string, contenu: Buffer, typeMime: string): Promise<void>;
  /** Suppression best effort (un objet absent n'est pas une erreur). */
  supprimer(cle: string): Promise<void>;
  /** URL de lecture temporaire (5 min, docs/07 §6) : présignée (S3) ou servie et signée par l'API (local). */
  urlLecture(cle: string): Promise<string>;
}

export const STOCKAGE_OBJETS = Symbol('STOCKAGE_OBJETS');

/** Durée de validité d'une URL de lecture (docs/04 §8). */
export const DUREE_URL_LECTURE_S = 300;

/** Clés acceptées : segments alphanumériques, tirets, points ; jamais de « .. » (pas de traversée de chemin). */
export function verifierCle(cle: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i.test(cle) || cle.includes('..')) {
    throw new Error(`Clé de stockage invalide : ${cle}`);
  }
  return cle;
}

import fr from './fr.json';

type Dictionnaire = typeof fr;
type Cles<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Cles<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Clé de traduction, vérifiée à la compilation (ex. `'connexion.titre'`). */
export type CleTexte = Cles<Dictionnaire>;

/**
 * Renvoie le libellé français d'une clé (docs/08 §2), avec substitution des paramètres `{nom}`.
 * Volontairement minimal : une seule langue au MVP, pas de dépendance i18n.
 */
export function t(cle: CleTexte, parametres?: Record<string, string | number>): string {
  let valeur: unknown = fr;
  for (const partie of cle.split('.')) valeur = (valeur as Record<string, unknown>)[partie];
  if (typeof valeur !== 'string') return cle;
  if (!parametres) return valeur;
  return valeur.replace(/\{(\w+)\}/g, (tout, nom: string) =>
    nom in parametres ? String(parametres[nom]) : tout,
  );
}

import { useNavigate, useSearch } from '@tanstack/react-router';

/** Paramètres d'URL communs aux listes : tri et pile des curseurs de pagination (docs/07 §3). */
export interface RechercheTableau {
  tri?: string;
  curseurs?: string[];
}

const vide = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const nettoyer = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => !vide(v)));

/** Lecture de paramètres d'URL tolérante (lien partagé, saisie manuelle). */
export const lireTexte = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
export const lireBooleen = (v: unknown): boolean | undefined =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
export const lireCurseurs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((c) => typeof c === 'string') && v.length ? (v as string[]) : undefined;

/**
 * État d'une liste porté par l'URL (recherche, filtres, tri, page) : partageable et conservé au retour
 * arrière. Changer un filtre ou le tri revient à la première page.
 */
export function useRechercheTableau<R extends RechercheTableau>() {
  const brute = useSearch({ strict: false });
  const recherche = brute as R;
  const naviguer = useNavigate();
  const curseurs = recherche.curseurs ?? [];

  const modifier = (maj: Partial<R>, { garderPage = false, historique = false } = {}) =>
    void naviguer({
      to: '.',
      search: ((prec: Record<string, unknown>) =>
        nettoyer({ ...prec, ...maj, ...(garderPage ? {} : { curseurs: undefined }) })) as never,
      replace: !historique,
    });

  return {
    recherche,
    modifier,
    curseur: curseurs.at(-1),
    pagination: {
      aPrecedente: curseurs.length > 0,
      precedente: () =>
        modifier({ curseurs: curseurs.slice(0, -1) } as Partial<R>, { garderPage: true, historique: true }),
      suivante: (curseur: string) =>
        modifier({ curseurs: [...curseurs, curseur] } as Partial<R>, { garderPage: true, historique: true }),
    },
    trier: (tri: string) => modifier({ tri } as Partial<R>),
  };
}

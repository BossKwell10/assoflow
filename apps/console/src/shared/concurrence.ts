import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { useState } from 'react';
import { lireEtag } from '../api/client';
import { estErreurApi } from '../api/erreurs';

/** Ajoute `If-Match: <etag>` aux options d'une requête. */
export function avecVersion(etag: string | undefined, options: RequestInit = {}): RequestInit {
  if (!etag) return options;
  const entetes = Object.fromEntries(new Headers(options.headers).entries());
  return { ...options, headers: { ...entetes, 'If-Match': etag } };
}

/** `412 PRECONDITION_ECHOUEE` : quelqu'un d'autre a modifié la fiche. */
export const estConflitVersion = (erreur: unknown): boolean => estErreurApi(erreur) && erreur.statut === 412;

/**
 * Mutation `PATCH` versionnée (docs/07 §5) : `If-Match` porte la version de la ressource telle qu'elle
 * était à l'ouverture du formulaire (champ `etag` du corps lu, sinon dernier en-tête `ETag` reçu pour
 * `chemin`), et non celle d'un rafraîchissement en arrière-plan ; puis celle renvoyée par chaque
 * `PATCH` réussi. Sur 412, `messageErreur` affiche « Cette fiche a été modifiée par quelqu'un d'autre,
 * rechargez-la » (docs/08 §3) et `AlerteErreur` propose de recharger.
 */
export function usePatchVersionne<Variables, Resultat extends { etag?: string } | undefined>(
  chemin: string,
  appel: (variables: Variables, options: RequestInit) => Promise<Resultat>,
  {
    etag,
    ...options
  }: Omit<UseMutationOptions<Resultat, unknown, Variables>, 'mutationFn'> & {
    etag?: string;
  } = {},
) {
  const [version] = useState(() => ({ etag: etag ?? lireEtag(chemin) }));
  return useMutation<Resultat, unknown, Variables>({
    ...options,
    mutationFn: async (variables) => {
      const resultat = await appel(variables, avecVersion(version.etag));
      version.etag = resultat?.etag ?? lireEtag(chemin) ?? version.etag;
      return resultat;
    },
  });
}

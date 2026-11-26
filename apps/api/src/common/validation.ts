import type { z } from 'zod';
import { ErreurMetier } from './erreur-metier.js';

/**
 * Valide une entrée avec un schéma Zod partagé (`@assoflow/contracts`).
 * Échec → `422 VALIDATION` avec le détail par champ dans `erreurs[]` (docs/07 §4).
 */
export function valider<S extends z.ZodType>(schema: S, valeur: unknown): z.infer<S> {
  const resultat = schema.safeParse(valeur ?? {});
  if (resultat.success) return resultat.data;
  throw new ErreurMetier(
    'VALIDATION',
    'Certains champs sont invalides',
    resultat.error.issues.map((i) => ({
      champ: i.path.join('.') || '(corps)',
      code: i.code.toUpperCase(),
      message: i.message,
    })),
  );
}

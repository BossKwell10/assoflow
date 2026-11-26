import { estErreurApi } from '../api/erreurs';
import { t } from '../i18n';

/** Message à montrer à l'utilisateur : `detail` du Problem Details (docs/07 §4), sinon message générique. */
export function messageErreur(erreur: unknown): string {
  if (estErreurApi(erreur)) return erreur.probleme.detail ?? t('commun.erreurInattendue');
  if (erreur instanceof TypeError) return t('commun.erreurReseau');
  return t('commun.erreurInattendue');
}

/** `erreurs[].champ` → message, pour les afficher sous les champs du formulaire. */
export function erreursDeChamps(erreur: unknown): Record<string, string> {
  if (!estErreurApi(erreur)) return {};
  return Object.fromEntries((erreur.probleme.erreurs ?? []).map((e) => [e.champ, e.message]));
}

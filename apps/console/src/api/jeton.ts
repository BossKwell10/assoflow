import type { Session } from './generated/modeles';

/**
 * Access token gardé en mémoire uniquement (docs/04 §3) : jamais de localStorage ni de sessionStorage.
 * Le refresh token est un cookie HttpOnly inaccessible au JavaScript.
 */
let accessToken: string | undefined;

export const lireJeton = () => accessToken;
export const definirJeton = (jeton: string | undefined) => {
  accessToken = jeton;
};

export type EvenementSession = { type: 'ouverte'; session: Session } | { type: 'perdue' };
type Ecouteur = (evenement: EvenementSession) => void;
const ecouteurs = new Set<Ecouteur>();

export function ecouterSession(ecouteur: Ecouteur): () => void {
  ecouteurs.add(ecouteur);
  return () => ecouteurs.delete(ecouteur);
}

/** Mémorise le jeton d'une session reçue (connexion, TOTP, refresh, contexte) et prévient l'application. */
export function ouvrirSession(session: Session) {
  definirJeton(session.accessToken);
  for (const e of ecouteurs) e({ type: 'ouverte', session });
}

/** Efface le jeton et prévient l'application (retour à /connexion). */
export function perdreSession() {
  definirJeton(undefined);
  for (const e of ecouteurs) e({ type: 'perdue' });
}

/** Lit une claim de l'access token (sans vérification : le serveur fait foi). */
export function lireClaim(jeton: string | undefined, claim: string): string | undefined {
  const charge = jeton?.split('.')[1];
  if (!charge) return undefined;
  try {
    const json = atob(charge.replace(/-/g, '+').replace(/_/g, '/'));
    const valeur = (JSON.parse(json) as Record<string, unknown>)[claim];
    return typeof valeur === 'string' ? valeur : undefined;
  } catch {
    return undefined;
  }
}

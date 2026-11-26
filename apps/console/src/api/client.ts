import { ENTETE_CONSOLE } from '@assoflow/contracts';
import { ErreurApi, versErreurApi } from './erreurs';
import { lireJeton, ouvrirSession, perdreSession } from './jeton';
import type { Session } from './generated/modeles';

/** Type d'erreur des hooks générés par orval. */
export type ErrorType<Erreur> = Erreur extends unknown ? ErreurApi : never;

/** Routes où un 401 est une réponse métier (identifiants, OTP, TOTP) et non une session expirée. */
const ROUTES_SANS_REFRESH = [
  '/auth/connexion',
  '/auth/totp',
  '/auth/refresh',
  '/auth/otp/',
  '/auth/mot-de-passe',
];
const sansRefresh = (url: string) =>
  ROUTES_SANS_REFRESH.some((r) =>
    r.endsWith('/') ? url.startsWith(r) : url === r || url.startsWith(`${r}?`),
  );

/**
 * Le contrat déclare le serveur `…/v1` ; les routes de santé sont toutefois exposées hors préfixe
 * (`/health/*`, voir apps/api bootstrap) — écart signalé.
 */
function urlComplete(url: string): string {
  const chemin = url.startsWith('/health/') ? url : `/v1${url}`;
  const origine = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  return new URL(chemin, origine).toString();
}

async function executer(url: string, init: RequestInit): Promise<Response> {
  const entetes = new Headers(init.headers);
  if (!entetes.has('Accept')) entetes.set('Accept', 'application/json');
  // Anti-CSRF exigé par `POST /v1/auth/refresh` côté console (docs/04 §3, §10).
  entetes.set(ENTETE_CONSOLE.nom, ENTETE_CONSOLE.valeur);
  // Un Authorization explicite (jeton intermédiaire d'activation TOTP) n'est jamais remplacé.
  const jeton = lireJeton();
  if (jeton && !entetes.has('Authorization')) entetes.set('Authorization', `Bearer ${jeton}`);
  return fetch(urlComplete(url), { ...init, headers: entetes, credentials: 'include' });
}

let refreshEnCours: Promise<boolean> | undefined;

/**
 * Refresh silencieux : un seul appel partagé par toutes les requêtes concurrentes.
 * Le refresh token voyage dans le cookie HttpOnly (`credentials: 'include'`).
 */
export function rafraichirSession(): Promise<boolean> {
  refreshEnCours ??= (async () => {
    try {
      const reponse = await executer('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!reponse.ok) return false;
      ouvrirSession((await reponse.json()) as Session);
      return true;
    } catch {
      return false;
    } finally {
      refreshEnCours = undefined;
    }
  })();
  return refreshEnCours;
}

/**
 * Dernier `ETag` reçu par ressource (chemin sans paramètres) : renvoyé en `If-Match` sur les `PATCH`
 * de la console (docs/07 §5, contrôle de concurrence optimiste).
 */
const etags = new Map<string, string>();
const cheminRessource = (url: string) => url.split('?')[0]!;

/** ETag connu pour une ressource (`/membres/…`), issu du dernier `GET` ou `PATCH` réussi. */
export const lireEtag = (chemin: string): string | undefined => etags.get(cheminRessource(chemin));

function memoriserEtag(url: string, reponse: Response) {
  const etag = reponse.headers.get('ETag');
  if (etag) etags.set(cheminRessource(url), etag);
}

/** Pour les tests : oublie les versions connues. */
export const oublierEtags = () => etags.clear();

async function lireCorps<T>(reponse: Response): Promise<T> {
  if (reponse.status === 204 || reponse.status === 205) return undefined as T;
  const type = reponse.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    const texte = await reponse.text();
    return (texte ? JSON.parse(texte) : undefined) as T;
  }
  if (type.startsWith('text/')) return (await reponse.text()) as T;
  return (await reponse.blob()) as T;
}

/**
 * Mutator des fonctions générées par orval : Bearer en mémoire, cookies, erreurs Problem Details,
 * et sur `401 JETON_EXPIRE` un refresh silencieux puis rejeu de la requête (docs/08 §3).
 */
export async function clientApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  let reponse = await executer(url, init);
  const jetonExplicite = new Headers(init.headers).has('Authorization');

  if (reponse.status === 401 && !sansRefresh(url) && !jetonExplicite) {
    const erreur = await versErreurApi(reponse);
    if (erreur.code !== 'JETON_EXPIRE') {
      // Session révoquée, appareil révoqué, jeton absent : retour à la connexion.
      perdreSession();
      throw erreur;
    }
    if (!(await rafraichirSession())) {
      perdreSession();
      throw erreur;
    }
    reponse = await executer(url, init);
    if (reponse.status === 401) {
      const seconde = await versErreurApi(reponse);
      perdreSession();
      throw seconde;
    }
  }

  if (!reponse.ok) throw await versErreurApi(reponse);
  memoriserEtag(url, reponse);
  return lireCorps<T>(reponse);
}

export default clientApi;

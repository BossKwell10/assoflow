import type { ErreurProbleme } from '@assoflow/contracts';

/** Erreur d'API au format Problem Details (docs/07-contrat-api.md §4). */
export class ErreurApi extends Error {
  constructor(readonly probleme: ErreurProbleme) {
    super(probleme.detail ?? probleme.title);
    this.name = 'ErreurApi';
  }
}

/**
 * Client minimal en attendant le client généré depuis openapi.yaml (orval).
 * L'access token est gardé en mémoire uniquement (docs/04 §3).
 */
let accessToken: string | undefined;
export const definirJeton = (jeton: string | undefined) => {
  accessToken = jeton;
};

export async function appelApi<T>(chemin: string, init: RequestInit = {}): Promise<T> {
  const entetes = new Headers(init.headers);
  entetes.set('Accept', 'application/json');
  if (accessToken) entetes.set('Authorization', `Bearer ${accessToken}`);
  const reponse = await fetch(chemin, { ...init, headers: entetes, credentials: 'include' });
  if (!reponse.ok) {
    const type = reponse.headers.get('content-type') ?? '';
    if (type.includes('application/problem+json')) throw new ErreurApi(await reponse.json());
    throw new ErreurApi({
      type: 'about:blank',
      title: 'ERREUR_INTERNE',
      status: reponse.status,
      code: 'ERREUR_INTERNE',
    });
  }
  return (await reponse.json()) as T;
}

import type { CodeErreur, ErreurProbleme } from '@assoflow/contracts';

/** Erreur d'API au format Problem Details (docs/07-contrat-api.md §4). */
export class ErreurApi extends Error {
  /** Secondes avant nouvel essai (en-tête `Retry-After`, ex. 423 compte verrouillé, 429). */
  readonly reessayerApres?: number;

  constructor(
    readonly probleme: ErreurProbleme,
    reessayerApres?: number,
  ) {
    super(probleme.detail ?? probleme.title);
    this.name = 'ErreurApi';
    this.reessayerApres = reessayerApres;
  }

  get code(): CodeErreur {
    return this.probleme.code;
  }

  get statut(): number {
    return this.probleme.status;
  }
}

export const estErreurApi = (e: unknown): e is ErreurApi => e instanceof ErreurApi;

/** Lit `Retry-After` (secondes ou date HTTP). */
function lireRetryAfter(valeur: string | null): number | undefined {
  if (!valeur) return undefined;
  const secondes = Number(valeur);
  if (Number.isInteger(secondes) && secondes >= 0) return secondes;
  const date = Date.parse(valeur);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Convertit une réponse en échec en `ErreurApi` (corps `application/problem+json` si présent). */
export async function versErreurApi(reponse: Response): Promise<ErreurApi> {
  const reessayer = lireRetryAfter(reponse.headers.get('Retry-After'));
  const type = reponse.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      const corps = (await reponse.json()) as Partial<ErreurProbleme>;
      if (corps && typeof corps.code === 'string') {
        return new ErreurApi(
          {
            type: corps.type ?? 'about:blank',
            title: corps.title ?? corps.code,
            status: corps.status ?? reponse.status,
            ...corps,
          } as ErreurProbleme,
          reessayer,
        );
      }
    } catch {
      // corps illisible : erreur générique ci-dessous
    }
  }
  const code = reponse.status === 401 ? 'NON_AUTHENTIFIE' : 'ERREUR_INTERNE';
  return new ErreurApi({ type: 'about:blank', title: code, status: reponse.status, code }, reessayer);
}

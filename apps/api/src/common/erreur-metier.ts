import { CODES_ERREUR, type CodeErreur } from '@assoflow/contracts';

/** Erreur fonctionnelle traduite en Problem Details (docs/07-contrat-api.md §4). */
export class ErreurMetier extends Error {
  readonly status: number;

  constructor(
    readonly code: CodeErreur,
    readonly detail: string,
    readonly erreurs: { champ: string; code: string; message: string }[] = [],
    /** En-têtes HTTP à ajouter à la réponse (ex. `Retry-After`). */
    readonly entetes: Record<string, string> = {},
  ) {
    super(detail);
    this.name = 'ErreurMetier';
    this.status = CODES_ERREUR[code];
  }
}

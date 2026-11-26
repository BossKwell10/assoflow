import { defineConfig, type InputTransformerFn } from 'orval';

const sansAccents = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Noms de dossiers et d'identifiants sans accents (« Accès et rôles » → acces-et-roles). */
const transformer: InputTransformerFn = (spec) => {
  for (const tag of spec.tags ?? []) tag.name = sansAccents(tag.name);
  for (const chemin of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(chemin ?? {}) as { tags?: unknown }[]) {
      if (op && Array.isArray(op.tags)) op.tags = op.tags.map((t) => sansAccents(String(t)));
    }
  }
  return spec;
};

/**
 * Client API de la console généré depuis le contrat (docs/07 §0, docs/08 §3).
 * Régénérer : `pnpm --filter @assoflow/console api:generer`. Ne jamais modifier `src/api/generated` à la main.
 */
export default defineConfig({
  assoflow: {
    input: { target: '../../docs/openapi.yaml', override: { transformer } },
    output: {
      mode: 'tags-split',
      target: 'src/api/generated',
      schemas: 'src/api/generated/modeles',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
      override: {
        mutator: { path: 'src/api/client.ts', name: 'clientApi' },
        fetch: { includeHttpResponseReturnType: false },
        query: { signal: true },
      },
    },
  },
});

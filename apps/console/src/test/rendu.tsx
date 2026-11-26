import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import type { Session } from '../api/generated/modeles';
import { routeTree } from '../router';
import { etatServeur } from './serveur';

/**
 * Rend la console sur un chemin. Avec `session`, le cookie de refresh est valide :
 * la reprise de session au chargement ouvre cette session (comme après un rechargement de page).
 */
export function rendreConsole(chemin: string, { session }: { session?: Session } = {}) {
  etatServeur.sessionCookie = session;
  const routeur = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [chemin] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const utilisateur = userEvent.setup();
  return { ...render(<App routeur={routeur} client={client} />), routeur, client, utilisateur };
}

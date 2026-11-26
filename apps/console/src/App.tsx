import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type AnyRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { estErreurApi } from './api/erreurs';
import { SessionProvider } from './auth/SessionProvider';
import { creerRouteur } from './router';
import { theme } from './theme';

/** Pas de nouvel essai sur une erreur fonctionnelle (4xx) : seules les erreurs réseau ou 5xx sont réessayées. */
const reessayer = (tentatives: number, erreur: unknown) =>
  tentatives < 2 && !(estErreurApi(erreur) && erreur.statut < 500);

export function App({ routeur, client }: { routeur?: AnyRouter; client?: QueryClient }) {
  const [c] = useState(
    () => client ?? new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: reessayer } } }),
  );
  const [r] = useState(() => routeur ?? creerRouteur());
  return (
    <MantineProvider theme={theme} env={import.meta.env.MODE === 'test' ? 'test' : 'default'}>
      <QueryClientProvider client={c}>
        <SessionProvider>
          <RouterProvider router={r} />
        </SessionProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}

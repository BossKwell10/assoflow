import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type AnyRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { creerRouteur } from './router';
import { theme } from './theme';

export function App({ routeur }: { routeur?: AnyRouter }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));
  const [r] = useState(() => routeur ?? creerRouteur());
  return (
    <MantineProvider theme={theme}>
      <QueryClientProvider client={client}>
        <RouterProvider router={r} />
      </QueryClientProvider>
    </MantineProvider>
  );
}

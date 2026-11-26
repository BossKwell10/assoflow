import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { routeTree } from './router';

const routeurSur = (chemin: string) =>
  createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [chemin] }) });

describe('console', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('affiche la navigation et le tableau de bord', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ statut: 'ok', dependances: { postgres: 'ok' } }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    render(<App routeur={routeurSur('/')} />);
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    expect(await screen.findByText('Opérationnelle')).toBeInTheDocument();
  });

  it('signale une API injoignable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    render(<App routeur={routeurSur('/')} />);
    expect(await screen.findByText('Injoignable')).toBeInTheDocument();
  });
});

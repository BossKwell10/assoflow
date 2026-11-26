import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { session } from './test/donnees';
import { rendreConsole } from './test/rendu';
import { serveur } from './test/serveur';

describe('console', () => {
  it('affiche la navigation et le tableau de bord', async () => {
    rendreConsole('/', { session: session() });
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    expect(await screen.findByText('Opérationnelle')).toBeInTheDocument();
  });

  it('signale une API injoignable', async () => {
    serveur.use(http.get('*/health/ready', () => new HttpResponse('', { status: 502 })));
    rendreConsole('/', { session: session() });
    expect(await screen.findByText('Injoignable')).toBeInTheDocument();
  });

  it('exige une session : sans cookie de refresh, la racine mène à la connexion', async () => {
    const { routeur } = rendreConsole('/');
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(routeur.state.location.pathname).toBe('/connexion');
  });
});

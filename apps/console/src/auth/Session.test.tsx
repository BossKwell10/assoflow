import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { session, utilisateur } from '../test/donnees';
import { rendreConsole } from '../test/rendu';
import { etatServeur, probleme, requetesVers, serveur } from '../test/serveur';

describe('session et garde de routes', () => {
  it('sans session, une page protégée redirige vers /connexion en mémorisant la destination', async () => {
    const { routeur } = rendreConsole('/parametres/utilisateurs');
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(routeur.state.location.pathname).toBe('/connexion');
    expect(routeur.state.location.search).toEqual({ redirect: '/parametres/utilisateurs' });
  });

  it('échec du refresh sur JETON_EXPIRE → retour à /connexion avec message', async () => {
    const { routeur } = rendreConsole('/parametres/utilisateurs', { session: session() });
    expect(await screen.findByRole('heading', { name: 'Utilisateurs et rôles' })).toBeInTheDocument();

    // Le jeton expire et le cookie de refresh n'est plus valide (inactivité côté serveur).
    etatServeur.sessionCookie = undefined;
    serveur.use(http.get('*/v1/roles', () => probleme(401, 'JETON_EXPIRE')));
    const { utilisateur: u } = { utilisateur: (await import('@testing-library/user-event')).default.setup() };
    await u.click(screen.getByRole('tab', { name: 'Rôles' }));

    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(routeur.state.location.pathname).toBe('/connexion');
    expect(screen.getByText('Votre session a expiré. Reconnectez-vous.')).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/refresh').length).toBeGreaterThanOrEqual(2);
  });

  it('masque les entrées de menu sans permission et affiche « Accès refusé » sur la route', async () => {
    const secretaireSansParametres = utilisateur({
      role: { code: 'agent', libelle: 'Agent de saisie' },
      permissions: ['association.lire', 'rapport.lire', 'membre.lire'],
    });
    rendreConsole('/parametres/utilisateurs', { session: session(secretaireSansParametres) });

    expect(await screen.findByRole('heading', { name: 'Accès refusé' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(within(nav).getByRole('link', { name: 'Membres' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Paramètres' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Trésorerie' })).not.toBeInTheDocument();
    expect(requetesVers('GET', '/v1/acces')).toHaveLength(0);
  });

  it('se déconnecte depuis le menu utilisateur', async () => {
    const { utilisateur: u } = rendreConsole('/', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Menu utilisateur' }));
    expect(await screen.findByText('Président')).toBeInTheDocument();
    await u.click(screen.getByRole('menuitem', { name: 'Se déconnecter' }));
    expect(await screen.findByText('Vous êtes déconnecté.')).toBeInTheDocument();
    await waitFor(() => expect(requetesVers('POST', '/v1/auth/deconnexion')).toHaveLength(1));
  });
});

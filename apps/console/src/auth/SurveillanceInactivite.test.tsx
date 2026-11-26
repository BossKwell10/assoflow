import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../test/donnees';
import { rendreConsole } from '../test/rendu';
import { requetesVers } from '../test/serveur';

const MINUTE = 60_000;

describe('RF-006 — inactivité', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('avertit à 28 min, prolonge sur « Rester connecté », déconnecte à 30 min', async () => {
    const { routeur } = rendreConsole('/', { session: session() });
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(27 * MINUTE));
    expect(screen.queryByRole('dialog', { name: 'Êtes-vous toujours là ?' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1 * MINUTE));
    const boite = await screen.findByRole('dialog', { name: 'Êtes-vous toujours là ?' });

    const refreshAvant = requetesVers('POST', '/v1/auth/refresh').length;
    act(() => screen.getByRole('button', { name: 'Rester connecté' }).click());
    expect(boite).not.toBeInTheDocument();
    await vi.waitFor(() => expect(requetesVers('POST', '/v1/auth/refresh').length).toBe(refreshAvant + 1));

    // Le délai repart de zéro : rien à 29 min après la prolongation…
    act(() => vi.advanceTimersByTime(27 * MINUTE));
    expect(screen.queryByRole('dialog', { name: 'Êtes-vous toujours là ?' })).not.toBeInTheDocument();
    // …puis avertissement et déconnexion au bout de 30 min sans activité.
    act(() => vi.advanceTimersByTime(1 * MINUTE));
    expect(await screen.findByRole('dialog', { name: 'Êtes-vous toujours là ?' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2 * MINUTE));

    expect(
      await screen.findByText('Vous avez été déconnecté après 30 minutes d’inactivité.'),
    ).toBeInTheDocument();
    expect(routeur.state.location.pathname).toBe('/connexion');
    expect(requetesVers('POST', '/v1/auth/deconnexion')).toHaveLength(1);
  });

  it('une activité de l’utilisateur repousse l’avertissement', async () => {
    rendreConsole('/', { session: session() });
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(20 * MINUTE));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    act(() => vi.advanceTimersByTime(20 * MINUTE));
    expect(screen.queryByRole('dialog', { name: 'Êtes-vous toujours là ?' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(8 * MINUTE));
    expect(await screen.findByRole('dialog', { name: 'Êtes-vous toujours là ?' })).toBeInTheDocument();
  });
});

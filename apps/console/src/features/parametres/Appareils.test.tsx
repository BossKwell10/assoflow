import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { session, session_commissaire } from '../../test/donnees';
import { requetesVers } from '../../test/serveur';
import { APPAREIL_TRESORIER_ID } from '../../test/serveurSprint5';
import { rendreConsole } from '../../test/rendu';

describe('A32 — Appareils et rejets de synchronisation (RF-SUP-033, RF-ADM-014)', () => {
  it('liste les appareils : version, préfixe, dernière synchro, en attente, rejets, statut', async () => {
    rendreConsole('/parametres/appareils', { session: session() });
    const tableau = await screen.findByRole('table', { name: 'Appareils' });
    const tresorier = within(tableau).getByRole('row', { name: /Tecno Spark 10/ });
    expect(within(tresorier).getByText('Koffi Yao')).toBeInTheDocument();
    expect(within(tresorier).getByText('Android')).toBeInTheDocument();
    expect(within(tresorier).getByText('1.2.0')).toBeInTheDocument();
    expect(within(tresorier).getByText('A01')).toBeInTheDocument();
    expect(within(tresorier).getByText('05/03/2027 09:14')).toBeInTheDocument();
    expect(within(tresorier).getByText('3')).toBeInTheDocument();
    expect(within(tresorier).getByText('2 à corriger')).toBeInTheDocument();
    expect(within(tresorier).getByText('Actif')).toBeInTheDocument();

    const jamais = within(tableau).getByRole('row', { name: /iPhone SE/ });
    expect(within(jamais).getByText('Jamais')).toBeInTheDocument();
    expect(within(jamais).getByText('—')).toBeInTheDocument();

    const revoque = within(tableau).getByRole('row', { name: /Ancien Itel/ });
    expect(within(revoque).getByText('Révoqué')).toBeInTheDocument();
    expect(within(revoque).getByText('Purge demandée')).toBeInTheDocument();
    expect(within(revoque).queryByRole('button', { name: /Révoquer/ })).not.toBeInTheDocument();
  });

  it('révoque un appareil avec motif obligatoire et purge', async () => {
    const { utilisateur: u } = rendreConsole('/parametres/appareils', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Révoquer l’appareil Tecno Spark 10' }));
    const boite = await screen.findByRole('dialog', { name: 'Révoquer l’appareil' });
    expect(within(boite).getByText(/Koffi Yao \(préfixe de reçu A01\)/)).toBeInTheDocument();
    await u.click(within(boite).getByRole('button', { name: 'Révoquer' }));
    expect(
      await within(boite).findByText(/motif/i, { selector: '.mantine-InputWrapper-error' }),
    ).toBeInTheDocument();
    expect(requetesVers('POST', /\/v1\/appareils\/.+\/revoquer/)).toHaveLength(0);

    await u.type(within(boite).getByLabelText(/^Motif/), 'Téléphone perdu');
    await u.click(within(boite).getByRole('checkbox', { name: /Effacer les données/ }));
    await u.click(within(boite).getByRole('button', { name: 'Révoquer' }));
    await waitFor(() => expect(requetesVers('POST', /\/v1\/appareils\/.+\/revoquer/)).toHaveLength(1));
    const requete = requetesVers('POST', /\/v1\/appareils\/.+\/revoquer/)[0]!;
    expect(requete.chemin).toBe(`/v1/appareils/${APPAREIL_TRESORIER_ID}/revoquer`);
    expect(requete.corps).toEqual({ motif: 'Téléphone perdu', purger: true });
    const ligne = await screen.findByRole('row', { name: /Tecno Spark 10.*Révoqué/ });
    expect(within(ligne).getByText('Purge demandée')).toBeInTheDocument();
  });

  it('sans utilisateur.gerer, la révocation est masquée (lecture seule)', async () => {
    rendreConsole('/parametres/appareils', { session: session_commissaire() });
    await screen.findByRole('table', { name: 'Appareils' });
    expect(screen.queryByRole('button', { name: /Révoquer/ })).not.toBeInTheDocument();
  });

  it('rejets : non acquittés par défaut, filtre par appareil, acquittés sur demande', async () => {
    const { utilisateur: u } = rendreConsole('/parametres/appareils', { session: session() });
    // Le tableau est recréé à chaque changement de filtre : on le relit à chaque étape.
    const rejets = () => screen.findByRole('table', { name: 'Rejets de synchronisation' });
    await waitFor(async () => expect(within(await rejets()).getAllByRole('row')).toHaveLength(3));
    expect(within(await rejets()).getByText('EXERCICE_FERME')).toBeInTheDocument();
    expect(within(await rejets()).queryByText('REFERENCE_INVALIDE')).not.toBeInTheDocument();

    await u.click(screen.getByRole('checkbox', { name: 'Inclure les rejets acquittés' }));
    await waitFor(async () =>
      expect(within(await rejets()).getByText('REFERENCE_INVALIDE')).toBeInTheDocument(),
    );
    expect(within(await rejets()).getByText('Acquitté')).toBeInTheDocument();

    await u.selectOptions(screen.getByLabelText('Appareil'), 'iPhone SE (A02) — Aya Kouassi');
    await waitFor(async () =>
      expect(within(await rejets()).queryByText('EXERCICE_FERME')).not.toBeInTheDocument(),
    );
    expect(within(await rejets()).getByText('REFERENCE_INVALIDE')).toBeInTheDocument();
    expect(requetesVers('GET', '/v1/sync/rejets').length).toBeGreaterThan(0);

    // Le badge de rejets d'un appareil filtre aussi la liste.
    await u.click(screen.getByRole('button', { name: 'Voir les 2 rejet(s) de Tecno Spark 10' }));
    await waitFor(async () => expect(within(await rejets()).getByText('EXERCICE_FERME')).toBeInTheDocument());
  });
});

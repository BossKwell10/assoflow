import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { session_secretaire } from '../../test/donnees';
import { requetesVers } from '../../test/serveur';
import { rendreConsole } from '../../test/rendu';

describe('Réunions — convocation d’AG par SMS (E6-08)', () => {
  it('planifie une réunion', async () => {
    const { utilisateur: u } = rendreConsole('/reunions', { session: session_secretaire() });
    await u.click(await screen.findByRole('button', { name: 'Nouvelle réunion' }));
    const boite = await screen.findByRole('dialog', { name: 'Nouvelle réunion' });
    await u.click(within(boite).getByRole('button', { name: 'Planifier' }));
    expect(await within(boite).findByText('Champ obligatoire')).toBeInTheDocument();
    await u.type(within(boite).getByLabelText(/^Titre/), 'AG extraordinaire');
    await u.type(within(boite).getByLabelText(/^Date/), '2099-05-02');
    await u.type(within(boite).getByLabelText('Lieu'), 'Place du village');
    await u.click(within(boite).getByRole('button', { name: 'Planifier' }));
    await waitFor(() => expect(requetesVers('POST', '/v1/reunions')).toHaveLength(1));
    expect(requetesVers('POST', '/v1/reunions')[0]!.corps).toMatchObject({
      type: 'ag_ordinaire',
      titre: 'AG extraordinaire',
      debut: '2099-05-02T10:00:00Z',
      lieu: 'Place du village',
    });
    expect(await screen.findByRole('row', { name: /AG extraordinaire/ })).toBeInTheDocument();
  });

  it('convoque tous les membres : aperçu, confirmation, résultat', async () => {
    const { utilisateur: u } = rendreConsole('/reunions', { session: session_secretaire() });
    await u.click(await screen.findByRole('button', { name: 'Convoquer : Assemblee generale 2027' }));
    const boite = await screen.findByRole('dialog', { name: 'Convoquer : Assemblee generale 2027' });
    const apercu = within(boite).getByRole('region', { name: 'Aperçu du SMS' });
    await waitFor(() =>
      expect(
        within(apercu).getByText(
          /^MUBE : Assemblee generale 2027 le 12\/04\/2099 a 10:00 a Foyer des jeunes/,
        ),
      ).toBeInTheDocument(),
    );
    await u.click(within(boite).getByRole('button', { name: 'Convoquer par SMS' }));
    await u.click(within(boite).getByRole('button', { name: 'Envoyer les convocations' }));
    expect(await within(boite).findByText('3 message(s) mis en file d’envoi.')).toBeInTheDocument();
    expect(requetesVers('POST', /\/v1\/reunions\/.+\/convoquer/)[0]!.corps).toEqual({
      canaux: ['sms'],
      cible: { tous: true },
    });
  });
});

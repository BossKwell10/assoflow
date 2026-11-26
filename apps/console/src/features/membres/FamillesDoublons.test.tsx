import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FAMILLES, membre, session } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, requetesVers } from '../../test/serveur';
import { regrouperDoublons } from './Doublons';

describe('A5 — Familles', () => {
  it('liste les familles et ouvre la fiche avec membres, chef et reste dû cumulé', async () => {
    const famille = etatServeur.familles[0]!;
    famille.chefFamilleId = etatServeur.membres[0]!.id;
    const { utilisateur: u } = rendreConsole('/membres/familles', { session: session() });
    await u.click(await screen.findByRole('link', { name: 'Famille Kouassi' }));
    expect(await screen.findByRole('heading', { name: 'Famille Kouassi' })).toBeInTheDocument();
    const tableau = screen.getByRole('table', { name: 'Membres de la famille' });
    expect(within(tableau).getAllByRole('row')).toHaveLength(3);
    const jean = within(tableau).getByRole('link', { name: 'Kouassi Jean' }).closest('tr')!;
    expect(within(jean).getByText('Chef de famille')).toBeInTheDocument();
    expect(screen.getByText('Reste dû cumulé').nextElementSibling).toHaveTextContent(/15\s000\sFCFA/);
  });

  it('crée une famille avec un identifiant client', async () => {
    const { utilisateur: u } = rendreConsole('/membres/familles', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Nouvelle famille' }));
    const boite = await screen.findByRole('dialog', { name: 'Nouvelle famille' });
    await u.type(within(boite).getByLabelText(/^Nom de la famille/), 'Famille Bamba');
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('link', { name: 'Famille Bamba' })).toBeInTheDocument();
    expect((requetesVers('POST', '/v1/familles')[0]?.corps as { id: string }).id).toMatch(/^[0-9a-f-]{14}7/);
    expect(FAMILLES).toHaveLength(1);
  });
});

describe('A7 — Doublons', () => {
  it('regroupe les suspects par nom ou téléphone', () => {
    const a = membre({ nom: 'Koné', prenoms: 'Awa', telephone: '+2250701' });
    const b = membre({ nom: 'KONE', prenoms: 'awa' });
    const c = membre({ nom: 'Traoré', prenoms: 'Ali', telephone: '+2250701' });
    const d = membre({ nom: 'Yao', prenoms: 'Paul' });
    expect(regrouperDoublons([a, b, c, d]).map((g) => g.length)).toEqual([3, 1]);
  });

  it('« Ce n’est pas un doublon » et « Désactiver celui-ci »', async () => {
    const [jean] = etatServeur.membres;
    const copie = membre({ nom: 'Kouassi', prenoms: 'Jean', doublonProbable: true });
    Object.assign(jean!, { doublonProbable: true });
    etatServeur.membres.push(copie);
    const { utilisateur: u } = rendreConsole('/membres/doublons', { session: session() });
    const groupe = await screen.findByRole('group', { name: 'Doublon probable : Kouassi Jean' });
    expect(within(groupe).getAllByRole('link', { name: 'Kouassi Jean' })).toHaveLength(2);

    await u.click(within(groupe).getAllByRole('button', { name: 'Désactiver Kouassi Jean' })[1]!);
    let boite = await screen.findByRole('dialog', { name: 'Désactiver le membre' });
    await u.type(within(boite).getByLabelText(/^Motif/), 'Doublon de MBR-000001');
    await u.click(within(boite).getByRole('button', { name: 'Désactiver' }));
    await waitFor(() => expect(copie.etat).toBe('desactive'));
    expect(requetesVers('POST', `/v1/membres/${copie.id}/desactiver`)).toHaveLength(1);

    await u.click((await screen.findAllByRole('button', { name: 'Kouassi Jean n’est pas un doublon' }))[0]!);
    boite = await screen.findByRole('dialog', { name: 'Ce n’est pas un doublon' });
    await u.click(within(boite).getByRole('button', { name: 'Confirmer' }));
    expect(await screen.findByText('Signalement retiré pour Kouassi Jean.')).toBeInTheDocument();
    expect(requetesVers('POST', `/v1/membres/${jean!.id}/doublon`)[0]?.corps).toEqual({
      decision: 'pas_doublon',
    });
  });
});

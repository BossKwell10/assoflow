import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { session, session_commissaire, session_secretaire } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, requetesVers } from '../../test/serveur';

const ficheDe = (index: number) => {
  const m = etatServeur.membres[index]!;
  return { m, chemin: `/membres/${m.id}` };
};

describe('A3 — Fiche membre', () => {
  it('affiche l’en-tête : numéro, statuts, diaspora, situation', async () => {
    const { chemin } = ficheDe(2);
    rendreConsole(chemin, { session: session() });
    expect(await screen.findByRole('heading', { name: 'Diabaté Fanta' })).toBeInTheDocument();
    expect(screen.getByText('MBR-000003')).toBeInTheDocument();
    expect(screen.getByText('Diaspora (France)')).toBeInTheDocument();
    expect(screen.getByText('+33612345678', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText('Actif').length).toBeGreaterThanOrEqual(2);
  });

  it('suspend avec motif obligatoire puis réactive', async () => {
    const { m, chemin } = ficheDe(0);
    const { utilisateur: u } = rendreConsole(chemin, { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Autres actions' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Suspendre' }));
    const boite = await screen.findByRole('dialog', { name: 'Suspendre le membre' });
    await u.click(within(boite).getByRole('button', { name: 'Suspendre' }));
    expect(
      await within(boite).findByText('Le motif est obligatoire (3 caractères minimum).'),
    ).toBeInTheDocument();
    expect(requetesVers('POST', /\/suspendre$/)).toHaveLength(0);

    await u.type(within(boite).getByLabelText(/^Motif/), 'Absences répétées');
    await u.click(within(boite).getByRole('button', { name: 'Suspendre' }));
    expect(await screen.findByText('Kouassi Jean est suspendu.')).toBeInTheDocument();
    expect(requetesVers('POST', `/v1/membres/${m.id}/suspendre`)[0]?.corps).toEqual({
      motif: 'Absences répétées',
    });
    expect(await screen.findByText('Suspendu')).toBeInTheDocument();
    expect(screen.getByText('Motif : Absences répétées')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Autres actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Suspendre' })).not.toBeInTheDocument();
    await u.click(await screen.findByRole('menuitem', { name: 'Réactiver' }));
    await u.click(
      within(await screen.findByRole('dialog', { name: 'Réactiver le membre' })).getByRole('button', {
        name: 'Réactiver',
      }),
    );
    expect(await screen.findByText('Kouassi Jean est réactivé.')).toBeInTheDocument();
    expect(m.etat).toBe('actif');
  });

  it('anonymise après double confirmation avec saisie du numéro (président)', async () => {
    const { m, chemin } = ficheDe(0);
    const { utilisateur: u } = rendreConsole(chemin, { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Autres actions' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Anonymiser' }));
    const boite = await screen.findByRole('dialog', { name: 'Anonymiser le membre' });
    expect(within(boite).getByText(/irréversible/)).toBeInTheDocument();

    // Étape 1 : motif obligatoire.
    await u.click(within(boite).getByRole('button', { name: 'Continuer' }));
    expect(
      await within(boite).findByText('Le motif est obligatoire (3 caractères minimum).'),
    ).toBeInTheDocument();
    await u.type(within(boite).getByLabelText(/^Motif/), 'Demande du membre (RGPD)');
    await u.click(within(boite).getByRole('button', { name: 'Continuer' }));

    // Étape 2 : saisie du numéro du membre.
    const confirmer = within(boite).getByRole('button', { name: 'Anonymiser définitivement' });
    expect(confirmer).toBeDisabled();
    const saisie = within(boite).getByLabelText(/saisissez le numéro du membre : MBR-000001/);
    await u.type(saisie, 'MBR-000002');
    expect(confirmer).toBeDisabled();
    await u.clear(saisie);
    await u.type(saisie, 'MBR-000001');
    expect(confirmer).toBeEnabled();
    expect(requetesVers('POST', /\/anonymiser$/)).toHaveLength(0);
    await u.click(confirmer);

    expect(await screen.findByText('Le membre a été anonymisé.')).toBeInTheDocument();
    expect(requetesVers('POST', `/v1/membres/${m.id}/anonymiser`)[0]?.corps).toEqual({
      motif: 'Demande du membre (RGPD)',
    });
    expect(await screen.findByRole('heading', { name: 'Anonyme MBR-000001' })).toBeInTheDocument();
    expect(screen.getByText('Anonymisée')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Modifier' })).not.toBeInTheDocument();
  });

  it('gère les ayants droit : ajout, modification, retrait', async () => {
    const { m, chemin } = ficheDe(0);
    const { utilisateur: u } = rendreConsole(chemin, { session: session() });
    await u.click(await screen.findByRole('tab', { name: 'Ayants droit' }));
    expect(await screen.findByText('Kouassi Marie')).toBeInTheDocument();
    expect(screen.getByText('Conjoint(e)')).toBeInTheDocument();

    // Ajout (identifiant UUIDv7 fourni par le client)
    await u.click(screen.getByRole('button', { name: 'Ajouter un ayant droit' }));
    let boite = await screen.findByRole('dialog', { name: 'Ajouter un ayant droit' });
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer' }));
    expect(within(boite).getAllByText('Champ obligatoire')).toHaveLength(3);
    await u.type(within(boite).getByLabelText(/^Nom/), 'Kouassi');
    await u.type(within(boite).getByLabelText(/^Prénoms/), 'Koffi');
    await u.selectOptions(within(boite).getByLabelText(/^Lien/), 'enfant');
    await u.type(within(boite).getByLabelText('Date de naissance'), '2015-06-01');
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Ayant droit Kouassi Koffi enregistré.')).toBeInTheDocument();
    const ajout = requetesVers('POST', `/v1/membres/${m.id}/ayants-droit`)[0]?.corps as Record<
      string,
      unknown
    >;
    expect(ajout).toMatchObject({
      nom: 'Kouassi',
      prenoms: 'Koffi',
      lien: 'enfant',
      dateNaissance: '2015-06-01',
    });
    expect(ajout.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(await screen.findByText('Kouassi Koffi')).toBeInTheDocument();

    // Modification
    await u.click(screen.getByRole('button', { name: 'Modifier l’ayant droit Kouassi Marie' }));
    boite = await screen.findByRole('dialog', { name: 'Modifier l’ayant droit' });
    await u.clear(within(boite).getByLabelText(/^Prénoms/));
    await u.type(within(boite).getByLabelText(/^Prénoms/), 'Marie-Laure');
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Kouassi Marie-Laure')).toBeInTheDocument();
    expect(requetesVers('PATCH', `/v1/membres/${m.id}/ayants-droit/ad-1`)[0]?.corps).toMatchObject({
      prenoms: 'Marie-Laure',
    });

    // Retrait
    await u.click(screen.getByRole('button', { name: 'Retirer l’ayant droit Kouassi Marie-Laure' }));
    boite = await screen.findByRole('dialog', { name: 'Retirer l’ayant droit' });
    await u.click(within(boite).getByRole('button', { name: 'Retirer' }));
    await waitFor(() => expect(screen.queryByText('Kouassi Marie-Laure')).not.toBeInTheDocument());
    expect(requetesVers('DELETE', `/v1/membres/${m.id}/ayants-droit/ad-1`)).toHaveLength(1);
  });

  it('masque les actions sans permission (commissaire : lecture seule, téléphone masqué)', async () => {
    const { chemin } = ficheDe(0);
    const { utilisateur: u } = rendreConsole(chemin, { session: session_commissaire() });
    expect(await screen.findByRole('heading', { name: 'Kouassi Jean' })).toBeInTheDocument();
    expect(screen.getByText(/\+225 07 •• •• 03 04/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Modifier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Autres actions' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('tab', { name: 'Ayants droit' }));
    expect(await screen.findByText('Kouassi Marie')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajouter un ayant droit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retirer/ })).not.toBeInTheDocument();
  });

  it('secrétaire : peut suspendre mais pas anonymiser', async () => {
    const { chemin } = ficheDe(0);
    const { utilisateur: u } = rendreConsole(chemin, { session: session_secretaire() });
    await u.click(await screen.findByRole('button', { name: 'Autres actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Suspendre' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Anonymiser' })).not.toBeInTheDocument();
  });

  it('refuse l’accès au formulaire de modification sans membre.modifier', async () => {
    const { chemin } = ficheDe(0);
    rendreConsole(`${chemin}/modifier`, { session: session_commissaire() });
    expect(await screen.findByRole('heading', { name: 'Accès refusé' })).toBeInTheDocument();
  });
});

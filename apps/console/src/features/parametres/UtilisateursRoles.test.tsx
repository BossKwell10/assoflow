import { ROLES_SYSTEME } from '@assoflow/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROLES, session, utilisateur } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, requetesVers } from '../../test/serveur';

const CHEMIN = '/parametres/utilisateurs';

describe('A30 — Utilisateurs et rôles', () => {
  it('liste les accès avec statut, téléphone masqué et verrouillage', async () => {
    rendreConsole(CHEMIN, { session: session() });
    const ligne = (await screen.findByText('Mariam Traoré')).closest('tr')!;
    expect(within(ligne).getByText('Secrétaire')).toBeInTheDocument();
    expect(within(ligne).getByText('+225 05 •• •• 08 09')).toBeInTheDocument();
    expect(within(ligne).getByText('Actif')).toBeInTheDocument();
    expect(within(ligne).getByText('Verrouillé')).toBeInTheDocument();
    expect(within(ligne).getByText('Jamais')).toBeInTheDocument();
    expect(screen.getAllByText('05/03/2027 14:30').length).toBeGreaterThan(0);
  });

  it('invite un utilisateur avec une clé d’idempotence et un téléphone normalisé', async () => {
    const { utilisateur: u } = rendreConsole(CHEMIN, { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Inviter un utilisateur' }));
    const boite = await screen.findByRole('dialog', { name: 'Inviter un utilisateur' });

    await u.click(within(boite).getByRole('button', { name: 'Envoyer l’invitation' }));
    expect(within(boite).getAllByText('Champ obligatoire').length).toBeGreaterThanOrEqual(3);
    expect(requetesVers('POST', '/v1/acces')).toHaveLength(0);

    await u.type(within(boite).getByLabelText(/^Nom/), 'Bamba');
    await u.type(within(boite).getByLabelText(/^Prénoms/), 'Seydou');
    await u.type(within(boite).getByLabelText(/^Téléphone/), '05 44 33 22 11');
    await waitFor(() => expect(within(boite).getAllByRole('option').length).toBeGreaterThan(1));
    await u.selectOptions(within(boite).getByLabelText(/^Rôle/), ROLES[1]!.id!);
    await u.click(within(boite).getByRole('button', { name: 'Envoyer l’invitation' }));

    expect(await screen.findByText('Invitation envoyée à Seydou Bamba.')).toBeInTheDocument();
    const [requete] = requetesVers('POST', '/v1/acces');
    expect(requete?.entetes.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(requete?.corps).toEqual({
      telephone: '+2250544332211',
      nom: 'Bamba',
      prenoms: 'Seydou',
      roleId: ROLES[1]!.id,
    });
    expect(await screen.findByText('Seydou Bamba')).toBeInTheDocument();
  });

  it('exige un motif pour révoquer un accès', async () => {
    const { utilisateur: u } = rendreConsole(CHEMIN, { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Révoquer l’accès de Koffi Yao' }));
    const boite = await screen.findByRole('dialog', { name: 'Révoquer l’accès' });
    expect(within(boite).getByText(/Koffi Yao \(Trésorier\)/)).toBeInTheDocument();

    await u.click(within(boite).getByRole('button', { name: 'Révoquer' }));
    expect(
      await within(boite).findByText('Le motif est obligatoire (3 caractères minimum).'),
    ).toBeInTheDocument();
    expect(requetesVers('POST', /\/revoquer$/)).toHaveLength(0);

    await u.type(within(boite).getByLabelText(/^Motif/), 'Fin de mandat');
    await u.click(within(boite).getByRole('button', { name: 'Révoquer' }));

    expect(await screen.findByText('Accès de Koffi Yao révoqué.')).toBeInTheDocument();
    const koffi = etatServeur.acces.find((a) => a.user?.prenoms === 'Koffi')!;
    expect(requetesVers('POST', `/v1/acces/${koffi.id}/revoquer`)[0]?.corps).toEqual({
      motif: 'Fin de mandat',
    });
    const ligne = (await screen.findByText('Koffi Yao')).closest('tr')!;
    expect(await within(ligne).findByText('Révoqué')).toBeInTheDocument();
  });

  it('déverrouille un compte après confirmation', async () => {
    const { utilisateur: u } = rendreConsole(CHEMIN, { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Déverrouiller le compte de Mariam Traoré' }));
    const boite = await screen.findByRole('dialog', { name: 'Déverrouiller le compte' });
    await u.click(within(boite).getByRole('button', { name: 'Déverrouiller' }));
    expect(await screen.findByText('Compte de Mariam Traoré déverrouillé.')).toBeInTheDocument();
    expect(requetesVers('POST', /\/deverrouiller$/)).toHaveLength(1);
  });

  it('en lecture seule (utilisateur.lire), masque les actions de gestion', async () => {
    const tresorier = utilisateur({
      role: { code: 'tresorier', libelle: 'Trésorier' },
      permissions: ROLES_SYSTEME.tresorier.permissions,
    });
    rendreConsole(CHEMIN, { session: session(tresorier) });
    expect(await screen.findByText('Koffi Yao')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inviter un utilisateur' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Révoquer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('affiche la matrice permissions × rôles', async () => {
    const { utilisateur: u } = rendreConsole(CHEMIN, { session: session() });
    await u.click(await screen.findByRole('tab', { name: 'Rôles' }));
    const ligne = (await screen.findByText('Payer une dépense')).closest('tr')!;
    const cellules = within(ligne).getAllByRole('cell');
    // Colonnes dans l'ordre des rôles : président, trésorier, secrétaire, commissaire, membre.
    expect(cellules.map((c) => c.textContent)).toEqual(['—Non', '✓Oui', '—Non', '—Non', '—Non']);
    expect(screen.getByText('réservée au président')).toBeInTheDocument();
  });
});

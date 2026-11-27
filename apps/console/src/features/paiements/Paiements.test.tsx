import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as csv from '../../shared/csv';
import { session, session_tresorier } from '../../test/donnees';
import { etatServeur, requetesVers } from '../../test/serveur';
import { CAISSE_ID, PAIEMENT_ID, WAVE_ID } from '../../test/serveurSprint4';
import { rendreConsole } from '../../test/rendu';

describe('A11 — Paiements', () => {
  it('liste : reçu, payeur, montant, mode, compte, statut ; total de la sélection', async () => {
    const { utilisateur: u } = rendreConsole('/cotisations/paiements', { session: session_tresorier() });
    const tableau = await screen.findByRole('table', { name: 'Paiements' });
    const ligne = within(tableau).getByRole('row', { name: /REC-2027-000002/ });
    expect(within(ligne).getByText('Mobile money (Wave)')).toBeInTheDocument();
    expect(within(ligne).getByText('Wave trésorier')).toBeInTheDocument();
    expect(within(ligne).getByText('Effectif')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Paiements' })).toHaveAttribute('aria-current', 'page');

    await u.click(screen.getByRole('checkbox', { name: 'Tout sélectionner sur cette page' }));
    const actions = screen.getByRole('region', { name: /Actions sur la sélection/ });
    expect(within(actions).getByText(/7\s000\sFCFA/)).toBeInTheDocument();
  });

  it('détail : imputations, reçu PDF ; annulation avec motif obligatoire', async () => {
    const telecharger = vi.spyOn(csv, 'telechargerBlob').mockImplementation(() => undefined);
    const { utilisateur: u } = rendreConsole('/cotisations/paiements', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Détail du paiement REC-2027-000001' }));
    const panneau = await screen.findByRole('dialog', { name: 'Paiement REC-2027-000001' });
    const imputations = within(panneau).getByRole('table', { name: 'Imputations' });
    expect(within(imputations).getByText('Cotisation mensuelle 2027')).toBeInTheDocument();
    expect(within(imputations).getByText(/Mars 2027/)).toBeInTheDocument();

    await u.click(within(panneau).getByRole('button', { name: 'Reçu PDF' }));
    await waitFor(() =>
      expect(telecharger).toHaveBeenCalledWith('recu-REC-2027-000001.pdf', expect.anything()),
    );

    await u.click(within(panneau).getByRole('button', { name: 'Annuler le paiement' }));
    const boite = await screen.findByRole('dialog', { name: 'Annuler le paiement' });
    await u.click(within(boite).getByRole('button', { name: 'Annuler le paiement' }));
    expect(
      await within(boite).findByText(/motif/i, { selector: '.mantine-InputWrapper-error' }),
    ).toBeInTheDocument();
    expect(requetesVers('POST', `/v1/paiements/${PAIEMENT_ID}/annuler`)).toHaveLength(0);
    await u.type(within(boite).getByLabelText(/Motif/), 'Erreur de saisie');
    await u.click(within(boite).getByRole('button', { name: 'Annuler le paiement' }));
    expect(
      await screen.findByText(/Paiement annulé : reçu d’annulation REC-2027-000003/),
    ).toBeInTheDocument();
    expect(requetesVers('POST', `/v1/paiements/${PAIEMENT_ID}/annuler`).at(-1)?.corps).toEqual({
      motif: 'Erreur de saisie',
    });
  });

  it('RG-COT-041 : bouton Annuler masqué quand le serveur l’interdit ; renvoi du reçu', async () => {
    const { utilisateur: u } = rendreConsole('/cotisations/paiements', { session: session_tresorier() });
    await u.click(await screen.findByRole('button', { name: 'Détail du paiement REC-2027-000002' }));
    const panneau = await screen.findByRole('dialog', { name: 'Paiement REC-2027-000002' });
    expect(within(panneau).queryByRole('button', { name: 'Annuler le paiement' })).not.toBeInTheDocument();
    await u.click(within(panneau).getByRole('button', { name: 'Renvoyer le reçu' }));
    expect(await within(panneau).findByText('Reçu renvoyé :')).toBeInTheDocument();
    expect(within(panneau).getAllByText('En attente').length).toBeGreaterThan(0);
  });
});

describe('A12 — Saisie de paiements en série', () => {
  it('membre au clavier, montant = reste dû, Entrée enregistre et vide la ligne ; liste de session', async () => {
    const { utilisateur: u } = rendreConsole('/cotisations/paiements/saisie', {
      session: session_tresorier(),
    });
    const recherche = await screen.findByRole('combobox', { name: /Membre/ });
    await u.type(recherche, 'Jean');
    expect(await screen.findByRole('option', { name: /Kouassi Jean/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await u.keyboard('{Enter}');
    expect(requetesVers('POST', '/v1/paiements')).toHaveLength(0);
    const montant = screen.getByLabelText(/^Montant/);
    await waitFor(() => expect(montant).toHaveValue('15 000'));
    await u.click(montant);
    await u.keyboard('{Enter}');

    const session = await screen.findByRole('table', { name: 'Paiements de la session' });
    expect(await within(session).findByText('REC-2027-000003')).toBeInTheDocument();
    expect(within(session).getByText('En attente')).toBeInTheDocument();
    const envoi = requetesVers('POST', '/v1/paiements').at(-1)!;
    expect(envoi.corps).toMatchObject({
      membreId: etatServeur.membres[0]!.id,
      montant: 15000,
      mode: 'especes',
      compteId: CAISSE_ID,
    });
    expect(String((envoi.corps as { id: string }).id)).toMatch(/^[0-9a-f-]{14}7/);
    expect(screen.getByRole('combobox', { name: /Membre/ })).toHaveValue('');
    expect(screen.getByRole('region', { name: 'Récapitulatif de la session' })).toHaveTextContent(
      /1 paiement\(s\)/,
    );
  });

  it('raccourci Alt+M : mobile money, compte mobile money par défaut, opérateur exigé', async () => {
    const { utilisateur: u } = rendreConsole('/cotisations/paiements/saisie', {
      session: session_tresorier(),
    });
    await u.type(await screen.findByRole('combobox', { name: /Membre/ }), 'Jean');
    await screen.findByRole('option', { name: /Kouassi Jean/ });
    await u.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByLabelText(/^Montant/)).toHaveValue('15\u202f000'));
    await u.keyboard('{Alt>}m{/Alt}');
    expect(screen.getByLabelText(/^Compte/)).toHaveValue(WAVE_ID);
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Opérateur obligatoire en mobile money')).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/paiements')).toHaveLength(0);
    await u.selectOptions(screen.getByLabelText(/^Opérateur/), 'wave');
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(requetesVers('POST', '/v1/paiements')).toHaveLength(1));
    expect(requetesVers('POST', '/v1/paiements')[0]!.corps).toMatchObject({
      mode: 'mobile_money',
      operateurMm: 'wave',
      compteId: WAVE_ID,
    });
  });

  it('RG-COT-031 : au-delà de 500 000 FCFA, confirmation explicite avant l’envoi', async () => {
    const { utilisateur: u } = rendreConsole('/cotisations/paiements/saisie', {
      session: session_tresorier(),
    });
    await u.type(await screen.findByRole('combobox', { name: /Membre/ }), 'Jean');
    await screen.findByRole('option', { name: /Kouassi Jean/ });
    await u.keyboard('{Enter}');
    const montant = screen.getByLabelText(/^Montant/);
    await waitFor(() => expect(montant).toHaveValue('15 000'));
    await u.clear(montant);
    await u.type(montant, '600000{Enter}');
    const boite = await screen.findByRole('dialog', { name: 'Montant élevé' });
    expect(within(boite).getByText(/600\s000\sFCFA pour MBR-000001/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/paiements')).toHaveLength(0);
    await u.click(within(boite).getByRole('button', { name: 'Confirmer et enregistrer' }));
    await waitFor(() => expect(requetesVers('POST', '/v1/paiements')).toHaveLength(1));
    expect(requetesVers('POST', '/v1/paiements')[0]!.corps).toMatchObject({
      montant: 600000,
      confirmationMontantEleve: true,
    });
  });

  it('fiche membre : onglet Paiements et action « Enregistrer un paiement » pré-remplie', async () => {
    const id = etatServeur.membres[0]!.id;
    const { utilisateur: u, routeur } = rendreConsole(`/membres/${id}`, { session: session_tresorier() });
    await u.click(await screen.findByRole('tab', { name: 'Paiements' }));
    expect(await screen.findByText('Aucun paiement.')).toBeInTheDocument();
    await u.click(screen.getByRole('link', { name: 'Enregistrer un paiement' }));
    await waitFor(() => expect(routeur.state.location.pathname).toBe('/cotisations/paiements/saisie'));
    expect(await screen.findByText(/MBR-000001 — Kouassi Jean/)).toBeInTheDocument();
  });
});

describe('A10 — Relancer', () => {
  it('estimation avant confirmation, puis résultat de la diffusion', async () => {
    const { utilisateur: u } = rendreConsole('/cotisations/echeances', { session: session_tresorier() });
    const tableau = await screen.findByRole('table', { name: 'Échéances' });
    const lignes = within(tableau).getAllByRole('checkbox', { name: /Sélectionner/ });
    await u.click(lignes[0]!);
    await u.click(lignes[1]!);
    await u.click(screen.getByRole('button', { name: 'Relancer' }));
    const boite = await screen.findByRole('dialog', { name: 'Relancer les membres' });
    expect(
      within(boite).getByText(/2 échéance\(s\) sélectionnée\(s\), soit environ 1 SMS/),
    ).toBeInTheDocument();
    await u.click(within(boite).getByRole('button', { name: 'Envoyer les relances' }));
    expect(await screen.findByText('1 message(s) mis en file d’envoi.')).toBeInTheDocument();
    expect(screen.getByText(/1 membre\(s\) sans contact/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/echeances/relancer')[0]!.corps).toMatchObject({
      echeanceIds: expect.arrayContaining([expect.any(String)]),
    });
  });
});

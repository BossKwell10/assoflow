import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { session, session_secretaire, session_tresorier } from '../../test/donnees';
import { requetesVers } from '../../test/serveur';
import { rendreConsole } from '../../test/rendu';

describe('A21 — Modèles de messages', () => {
  it('édition : variable insérée, aperçu avec unités, passage en Unicode signalé', async () => {
    const { utilisateur: u } = rendreConsole('/communication?onglet=modeles', {
      session: session_secretaire(),
    });
    await u.click(await screen.findByRole('button', { name: 'Modifier le modèle Rappel de retard' }));
    const boite = await screen.findByRole('dialog', { name: /Rappel de retard/ });
    const texte = within(boite).getByLabelText('Texte du message');
    await u.clear(texte);
    await u.click(texte);
    await u.paste('Bonjour, ');
    await u.click(within(boite).getByRole('button', { name: 'Insérer montant' }));
    expect(texte).toHaveValue('Bonjour, {{montant}}');
    const apercu = within(boite).getByRole('region', { name: 'Aperçu du SMS' });
    expect(within(apercu).getByText('Bonjour, 5 000')).toBeInTheDocument();
    expect(within(apercu).getByText(/14 caractères — 1 SMS \(GSM-7\)/)).toBeInTheDocument();

    await u.click(texte);
    await u.paste(' fête');
    expect(within(apercu).getByText(/1 SMS \(Unicode\)/)).toBeInTheDocument();
    expect(within(apercu).getByText(/hors GSM-7.*ê/)).toBeInTheDocument();

    await u.click(within(boite).getByRole('button', { name: 'Enregistrer le modèle' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Rappel de retard/ })).not.toBeInTheDocument(),
    );
    expect(requetesVers('PUT', '/v1/modeles-notification/rappel_retard/sms')[0]!.corps).toEqual({
      contenu: 'Bonjour, {{montant}} fête',
    });
    const ligne = await screen.findByRole('row', { name: /Rappel de retard/ });
    expect(within(ligne).getByText('Personnalisé')).toBeInTheDocument();

    await u.click(within(ligne).getByRole('button', { name: 'Revenir au modèle global' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Revenir au modèle global' });
    await u.click(within(confirmation).getByRole('button', { name: 'Revenir au modèle global' }));
    await waitFor(() =>
      expect(requetesVers('DELETE', '/v1/modeles-notification/rappel_retard/sms')).toHaveLength(1),
    );
  });

  it('variable inconnue : refus de l’API (422) affiché sous le texte', async () => {
    const { utilisateur: u } = rendreConsole('/communication?onglet=modeles', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Modifier le modèle Rappel avant échéance' }));
    const boite = await screen.findByRole('dialog', { name: /Rappel avant échéance/ });
    const texte = within(boite).getByLabelText('Texte du message');
    await u.click(texte);
    await u.paste(' {{membre.telephone}}');
    expect(
      within(boite).getByText(/Variables inconnues pour ce modèle : membre.telephone/),
    ).toBeInTheDocument();
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer le modèle' }));
    expect(await within(boite).findByRole('alert')).toHaveTextContent(/Variable inconnue/);
    expect(
      within(boite).getAllByText(/Variable inconnue pour ce modèle : membre.telephone/).length,
    ).toBeGreaterThan(0);
  });
});

describe('A22 — Historique des envois', () => {
  it('statuts, relais famille, jauge de consommation et filtre', async () => {
    const { utilisateur: u } = rendreConsole('/communication', { session: session_secretaire() });
    const tableau = await screen.findByRole('table', { name: 'Historique des envois' });
    const recu = within(tableau).getByRole('row', { name: /Reçu de paiement/ });
    expect(within(recu).getByText('Remis')).toBeInTheDocument();
    const rappel = within(tableau).getByRole('row', { name: /Rappel de retard/ });
    expect(within(rappel).getByText('Hors quota')).toBeInTheDocument();
    expect(within(rappel).getByText('via le chef de famille')).toBeInTheDocument();
    expect(await screen.findByText('412 / 500 unités (82 %)')).toBeInTheDocument();
    expect(screen.getByText(/1 message\(s\) non envoyé\(s\) faute de quota/)).toBeInTheDocument();

    await u.selectOptions(screen.getByLabelText('Statut'), 'hors_quota');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Historique des envois' })).queryByText('Remis'),
      ).toBeNull(),
    );
  });

  it('menu Communication masqué sans permission', async () => {
    rendreConsole('/cotisations/paiements', { session: session_tresorier() });
    await screen.findByRole('table', { name: 'Paiements' });
    expect(screen.queryByRole('link', { name: 'Communication' })).not.toBeInTheDocument();
  });
});

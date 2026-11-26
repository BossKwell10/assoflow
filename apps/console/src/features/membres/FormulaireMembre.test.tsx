import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FAMILLES, session } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, requetesVers } from '../../test/serveur';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('A4 — Formulaire membre', () => {
  it('crée un membre avec un UUIDv7 client, un téléphone normalisé et le consentement obligatoire', async () => {
    const { utilisateur: u, routeur } = rendreConsole('/membres/nouveau', { session: session() });
    await u.type(await screen.findByLabelText(/^Nom/), 'Bamba');
    await u.type(screen.getByLabelText(/^Prénoms/), 'Seydou');

    // RG-MBR-002 affichée tant qu'il n'y a ni téléphone ni famille.
    expect(
      screen.getByText(/Renseignez un téléphone ou rattachez le membre à une famille/),
    ).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(
      await screen.findByText('L’accord du membre est obligatoire pour l’enregistrer.'),
    ).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/membres')).toHaveLength(0);

    await u.type(screen.getByLabelText(/^Téléphone/), '05 44 33 22 11');
    expect(screen.queryByText(/Renseignez un téléphone ou rattachez/)).not.toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: /a donné son accord/ }));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(routeur.state.location.pathname).toMatch(/^\/membres\/[0-9a-f-]{36}$/));
    const [requete] = requetesVers('POST', '/v1/membres');
    const corps = requete?.corps as Record<string, unknown>;
    expect(corps.id).toMatch(UUID_V7);
    expect(requete?.entetes.get('Idempotency-Key')).toBe(corps.id);
    expect(corps).toMatchObject({
      nom: 'Bamba',
      prenoms: 'Seydou',
      telephone: '+2250544332211',
      paysResidence: 'CI',
      statutAdhesion: 'actif',
    });
    expect(routeur.state.location.pathname).toBe(`/membres/${String(corps.id)}`);
    expect(await screen.findByRole('heading', { name: 'Bamba Seydou' })).toBeInTheDocument();
  });

  it('accepte un membre sans téléphone rattaché à une famille (RG-MBR-002)', async () => {
    const { utilisateur: u } = rendreConsole('/membres/nouveau', { session: session() });
    await u.type(await screen.findByLabelText(/^Nom/), 'Kouassi');
    await u.type(screen.getByLabelText(/^Prénoms/), 'Ama');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Famille Kouassi' })).toBeInTheDocument());
    await u.selectOptions(screen.getByLabelText('Famille'), FAMILLES[0]!.id!);
    await u.click(screen.getByRole('checkbox', { name: /a donné son accord/ }));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(requetesVers('POST', '/v1/membres')).toHaveLength(1));
    expect(requetesVers('POST', '/v1/membres')[0]?.corps).toMatchObject({
      telephone: null,
      familleId: FAMILLES[0]!.id,
    });
  });

  it('avertit d’un doublon probable (422 CONFIRMATION_REQUISE) avec un lien vers la fiche, puis confirme', async () => {
    const jean = etatServeur.membres[0]!;
    const { utilisateur: u, routeur } = rendreConsole('/membres/nouveau', { session: session() });
    await u.type(await screen.findByLabelText(/^Nom/), 'Kouassi');
    await u.type(screen.getByLabelText(/^Prénoms/), 'Jean');
    await u.type(screen.getByLabelText(/^Téléphone/), '0701020304');
    await u.click(screen.getByRole('checkbox', { name: /a donné son accord/ }));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const alerte = await screen.findByRole('alert');
    expect(within(alerte).getByText('Doublon probable')).toBeInTheDocument();
    expect(within(alerte).getByRole('link', { name: 'Voir la fiche' })).toHaveAttribute(
      'href',
      `/membres/${jean.id}`,
    );
    expect(etatServeur.membres).toHaveLength(4);
    const [premiere] = requetesVers('POST', '/v1/membres');
    expect(premiere?.corps).toMatchObject({ consentement: { traitementDonnees: true, canal: 'papier' } });
    expect(premiere?.corps).not.toHaveProperty('confirmationDoublon');

    await u.click(within(alerte).getByRole('button', { name: 'Enregistrer quand même' }));
    await waitFor(() => expect(routeur.state.location.pathname).not.toBe('/membres/nouveau'));
    const seconde = requetesVers('POST', '/v1/membres')[1]!;
    const corps = seconde.corps as Record<string, unknown>;
    expect(corps).toMatchObject({ id: (premiere?.corps as { id: string }).id, confirmationDoublon: true });
    expect(seconde.entetes.get('Idempotency-Key')).not.toBe(corps.id);
    expect(etatServeur.membres.at(-1)).toMatchObject({ doublonProbable: true, doublonDe: jean.id });
  });

  it('modifie un membre avec If-Match (ETag du GET) et n’envoie que les champs modifiés', async () => {
    const jean = etatServeur.membres[0]!;
    const { utilisateur: u, routeur } = rendreConsole(`/membres/${jean.id}/modifier`, { session: session() });
    const lieu = await screen.findByLabelText('Lieu de résidence');
    await u.type(lieu, 'Abidjan');
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(routeur.state.location.pathname).toBe(`/membres/${jean.id}`));
    const [requete] = requetesVers('PATCH', `/v1/membres/${jean.id}`);
    expect(requete?.entetes.get('If-Match')).toBe('"v1"');
    expect(requete?.corps).toEqual({ lieuResidence: 'Abidjan' });
    expect(jean.lieuResidence).toBe('Abidjan');
  });

  it('sur 412, signale la modification concurrente et recharge la fiche', async () => {
    const jean = etatServeur.membres[0]!;
    const { utilisateur: u } = rendreConsole(`/membres/${jean.id}/modifier`, { session: session() });
    const lieu = await screen.findByLabelText('Lieu de résidence');
    // Quelqu'un d'autre modifie la fiche entre-temps.
    etatServeur.versions.set(jean.id, 2);
    jean.notes = 'Modifié ailleurs';
    await u.type(lieu, 'Abidjan');
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const alerte = await screen.findByRole('alert');
    expect(alerte).toHaveTextContent('Cette fiche a été modifiée par quelqu’un d’autre, rechargez-la');
    expect(requetesVers('PATCH', `/v1/membres/${jean.id}`)[0]?.entetes.get('If-Match')).toBe('"v1"');

    await u.click(within(alerte).getByRole('button', { name: 'Recharger la fiche' }));
    expect(await screen.findByDisplayValue('Modifié ailleurs')).toBeInTheDocument();
    expect(screen.getByLabelText('Lieu de résidence')).toHaveValue('');
    await u.type(screen.getByLabelText('Lieu de résidence'), 'Bouaké');
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(requetesVers('PATCH', `/v1/membres/${jean.id}`)).toHaveLength(2));
    expect(requetesVers('PATCH', `/v1/membres/${jean.id}`)[1]?.entetes.get('If-Match')).toBe('"v2"');
    await waitFor(() => expect(jean.lieuResidence).toBe('Bouaké'));
  });
});

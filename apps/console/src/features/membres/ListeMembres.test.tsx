import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as csv from '../../shared/csv';
import { ROLES_SYSTEME } from '@assoflow/contracts';
import { membre, session, session_commissaire, session_secretaire, utilisateur } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, requetesVers } from '../../test/serveur';

describe('A2 — Liste des membres', () => {
  afterEach(() => vi.restoreAllMocks());

  it('affiche les colonnes de la spécification (statut, état, solde, accès app)', async () => {
    rendreConsole('/membres', { session: session() });
    const ligne = (await screen.findByRole('link', { name: 'Kouassi Jean' })).closest('tr')!;
    expect(within(ligne).getByText('MBR-000001')).toBeInTheDocument();
    expect(within(ligne).getByText('+225 07 01 02 03 04')).toBeInTheDocument();
    expect(within(ligne).getByText('Membre ordinaire')).toBeInTheDocument();
    expect(await within(ligne).findByText('Famille Kouassi')).toBeInTheDocument();
    expect(ligne).toHaveTextContent(/−15\s000\sFCFA/);
    const yao = screen.getByRole('link', { name: 'Yao Paul' }).closest('tr')!;
    expect(within(yao).getByText('Suspendu')).toBeInTheDocument();
  });

  it('recherche instantanée et filtres synchronisés dans l’URL', async () => {
    const { routeur, utilisateur: u } = rendreConsole('/membres', { session: session() });
    await screen.findByRole('link', { name: 'Kouassi Jean' });

    await u.type(screen.getByLabelText('Rechercher un membre', { exact: false }), 'diab');
    await waitFor(() => expect(routeur.state.location.search).toMatchObject({ q: 'diab' }));
    expect(await screen.findByRole('link', { name: 'Diabaté Fanta' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Kouassi Jean' })).not.toBeInTheDocument());
    // Debounce : une seule requête pour la saisie complète.
    expect(requetesVers('GET', '/v1/membres')).toHaveLength(2);

    await u.click(screen.getByRole('checkbox', { name: 'Diaspora' }));
    await waitFor(() => expect(routeur.state.location.search).toMatchObject({ q: 'diab', diaspora: true }));
    await u.selectOptions(screen.getByLabelText('État'), 'suspendu');
    await waitFor(() => expect(routeur.state.location.search).toMatchObject({ etat: 'suspendu' }));
    expect(await screen.findByText('Aucun membre ne correspond à ces critères.')).toBeInTheDocument();
  });

  it('relit les filtres depuis l’URL (lien partagé)', async () => {
    rendreConsole('/membres?enRetard=true', { session: session() });
    expect(await screen.findByRole('link', { name: 'Kouassi Jean' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Diabaté Fanta' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'En retard de cotisation' })).toBeChecked();
  });

  it('pagine par curseur (50 par page) et garde la page dans l’URL', async () => {
    etatServeur.membres = Array.from({ length: 55 }, (_, i) =>
      membre({ nom: `Membre${String(i).padStart(2, '0')}`, prenoms: 'Test' }),
    );
    const { routeur, utilisateur: u } = rendreConsole('/membres', { session: session() });
    expect(await screen.findByRole('link', { name: 'Membre00 Test' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(51);

    await u.click(screen.getByRole('button', { name: 'Page suivante' }));
    expect(await screen.findByRole('link', { name: 'Membre50 Test' })).toBeInTheDocument();
    expect(routeur.state.location.search).toMatchObject({ curseurs: ['50'] });
    expect(screen.getByRole('button', { name: 'Page suivante' })).toBeDisabled();

    await u.click(screen.getByRole('button', { name: 'Page précédente' }));
    expect(await screen.findByRole('link', { name: 'Membre00 Test' })).toBeInTheDocument();
  });

  it('trie par en-tête de colonne via l’URL', async () => {
    const { routeur, utilisateur: u } = rendreConsole('/membres', { session: session() });
    await screen.findByRole('link', { name: 'Kouassi Jean' });
    await u.click(screen.getByRole('button', { name: 'Trier par Nom et prénoms' }));
    await waitFor(() => expect(routeur.state.location.search).toMatchObject({ tri: 'nom' }));
    await u.click(screen.getByRole('button', { name: 'Trier par Nom et prénoms' }));
    await waitFor(() => expect(routeur.state.location.search).toMatchObject({ tri: '-nom' }));
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: /Paul|Jean|Fanta|Adjoua/ })[0]).toHaveTextContent(
        'Yao Paul',
      ),
    );
  });

  it('exporte la sélection de la page en CSV', async () => {
    const telecharger = vi.spyOn(csv, 'telechargerFichier').mockImplementation(() => undefined);
    const { utilisateur: u } = rendreConsole('/membres', { session: session() });
    await u.click(await screen.findByRole('checkbox', { name: 'Sélectionner Kouassi Jean' }));
    await u.click(screen.getByRole('checkbox', { name: 'Sélectionner Diabaté Fanta' }));
    expect(screen.getByText('2 sélectionné(s)')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Exporter la sélection (CSV)' }));
    const [nom, contenu] = telecharger.mock.calls[0]!;
    expect(nom).toMatch(/^membres-\d{4}-\d{2}-\d{2}\.csv$/);
    const lignes = contenu.split('\r\n');
    expect(lignes[0]).toContain('Numéro;Nom;Prénoms;Téléphone');
    expect(lignes).toHaveLength(4);
    // Le « + » initial est neutralisé (injection de formules dans Excel).
    expect(lignes[1]).toContain("MBR-000001;Kouassi;Jean;'+225 07 01 02 03 04");
  });

  it('masque partiellement le téléphone pour le commissaire aux comptes', async () => {
    rendreConsole('/membres', { session: session_commissaire() });
    const ligne = (await screen.findByRole('link', { name: 'Kouassi Jean' })).closest('tr')!;
    expect(within(ligne).getByText('+225 07 •• •• 03 04')).toBeInTheDocument();
    expect(screen.queryByText('+225 07 01 02 03 04')).not.toBeInTheDocument();
    // Lecture seule : ni création, ni import.
    expect(screen.queryByRole('link', { name: 'Nouveau membre' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Importer/ })).not.toBeInTheDocument();
  });

  it('propose Nouveau, Importer (désactivé) et Doublons (n) selon les permissions', async () => {
    Object.assign(etatServeur.membres[1]!, { doublonProbable: true });
    rendreConsole('/membres', { session: session_secretaire() });
    expect(await screen.findByRole('link', { name: 'Doublons (1)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nouveau membre' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importer (sprint 3)' })).toBeDisabled();
  });

  it('refuse la route et masque le menu sans membre.lire', async () => {
    const simple = utilisateur({
      role: { code: 'membre', libelle: 'Membre' },
      permissions: ROLES_SYSTEME.membre.permissions,
    });
    rendreConsole('/membres', { session: session(simple) });
    expect(await screen.findByRole('heading', { name: 'Accès refusé' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Membres' })).not.toBeInTheDocument();
    expect(requetesVers('GET', '/v1/membres')).toHaveLength(0);
  });
});

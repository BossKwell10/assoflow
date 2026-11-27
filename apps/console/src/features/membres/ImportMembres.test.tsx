import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as csv from '../../shared/csv';
import { session, session_secretaire, session_tresorier } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { requetesVers } from '../../test/serveur';
import { etatS3 } from '../../test/serveurSprint3';

const fichier = (nom = 'membres.csv', type = 'text/csv') => new File(['nom;prenoms\nA;B\n'], nom, { type });

describe('A6 — Import de membres (RF-024, RG-MBR-007)', () => {
  it('parcours : modèle, dépôt, rapport filtrable, attestation obligatoire, confirmation et résumé', async () => {
    const telecharger = vi.spyOn(csv, 'telechargerBlob').mockImplementation(() => undefined);
    const { utilisateur: u } = rendreConsole('/membres/import', { session: session_secretaire() });
    await u.click(await screen.findByRole('button', { name: 'Télécharger le modèle Excel' }));
    await waitFor(() =>
      expect(telecharger).toHaveBeenCalledWith('modele-import-membres.xlsx', expect.anything()),
    );

    fireEvent.change(screen.getByLabelText('Fichier à importer (CSV ou Excel)'), {
      target: { files: [fichier()] },
    });
    expect(await screen.findByText('Lignes lues')).toBeInTheDocument();
    expect(screen.getByText('Colonnes ignorées (inconnues) : profession')).toBeInTheDocument();
    const tableau = screen.getByRole('table', { name: 'Lignes en erreur ou en doublon' });
    expect(within(tableau).getAllByRole('row')).toHaveLength(4);
    await u.click(screen.getByRole('radio', { name: 'Erreurs' }));
    expect(within(tableau).getAllByRole('row')).toHaveLength(3);
    expect(within(tableau).getByText('téléphone « 12 » invalide')).toBeInTheDocument();

    // Sans attestation : aucune requête.
    await u.click(screen.getByRole('button', { name: 'Créer 4 membre(s)' }));
    expect(await screen.findByText('L’attestation est obligatoire pour importer.')).toBeInTheDocument();
    expect(requetesVers('POST', /\/confirmer$/)).toHaveLength(0);

    await u.click(screen.getByLabelText('Inclure les doublons probables (1)'));
    await u.click(screen.getByLabelText(/J’atteste que les membres importés/));
    await u.click(screen.getByRole('button', { name: 'Créer 5 membre(s)' }));
    expect(
      await screen.findByText(
        '5 membre(s) créé(s) dont 1 à vérifier, 1 famille(s) créée(s), 0 ligne(s) ignorée(s), 1 erreur(s).',
      ),
    ).toBeInTheDocument();
    expect(requetesVers('POST', /\/confirmer$/)[0]?.corps).toEqual({
      inclureDoublons: true,
      attestationConsentement: true,
    });
    expect(screen.getByText('Catégorie introuvable ou inactive')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Vérifier les doublons' })).toBeInTheDocument();
  });

  it('affiche l’erreur de structure renvoyée par l’API ; refuse un type de fichier non pris en charge', async () => {
    etatS3.erreurImport = { code: 'COLONNE_MANQUANTE', message: 'Colonne « nom » introuvable' };
    rendreConsole('/membres/import', { session: session() });
    const champ = await screen.findByLabelText('Fichier à importer (CSV ou Excel)');
    // `fireEvent` : le filtre `accept` du navigateur est contourné (glisser-déposer, sélecteur « tous les fichiers »).
    fireEvent.change(champ, { target: { files: [new File(['x'], 'photo.png', { type: 'image/png' })] } });
    expect(await screen.findByText(/Formats acceptés : CSV, XLSX/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/membres/import')).toHaveLength(0);
    // Un CSV non typé par le navigateur est accepté par son extension.
    fireEvent.change(champ, { target: { files: [fichier('export.csv', '')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Colonne « nom » introuvable');
  });

  it('écran réservé à membre.importer (le trésorier n’y a pas accès ; bouton masqué dans la liste)', async () => {
    rendreConsole('/membres/import', { session: session_tresorier() });
    expect(await screen.findByText('Accès refusé')).toBeInTheDocument();
  });
});

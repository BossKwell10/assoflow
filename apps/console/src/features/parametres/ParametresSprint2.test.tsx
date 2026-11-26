import { ROLES_SYSTEME } from '@assoflow/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { session, session_secretaire, utilisateur } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, probleme, requetesVers, serveur } from '../../test/serveur';

describe('A28 — Exercices', () => {
  it('refuse la clôture tant que des dépenses sont en cours (DEPENSES_EN_COURS)', async () => {
    etatServeur.depensesEnCours = true;
    const { utilisateur: u } = rendreConsole('/parametres/exercices', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Clôturer l’exercice 2027' }));
    const boite = await screen.findByRole('dialog', { name: 'Clôturer l’exercice' });
    expect(within(boite).getByText(/du 01\/01\/2027 au 31\/12\/2027/)).toBeInTheDocument();
    await u.click(within(boite).getByRole('button', { name: 'Clôturer' }));
    const alerte = await within(boite).findByRole('alert');
    expect(alerte).toHaveTextContent('Clôture impossible : des dépenses soumises ou validées sont datées');
    expect(alerte).toHaveTextContent('2 dépenses soumises ou validées sont datées dans l’exercice 2027.');
    expect(etatServeur.exercices[1]!.statut).toBe('ouvert');

    etatServeur.depensesEnCours = false;
    await u.click(within(boite).getByRole('button', { name: 'Clôturer' }));
    expect(await screen.findByText('Exercice 2027 clôturé.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clôturer l’exercice 2027' })).not.toBeInTheDocument();
  });

  it('crée l’exercice suivant avec des dates proposées (12 mois)', async () => {
    const { utilisateur: u } = rendreConsole('/parametres/exercices', { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Nouvel exercice' }));
    const boite = await screen.findByRole('dialog', { name: 'Nouvel exercice' });
    expect(within(boite).getByLabelText(/^Début/)).toHaveValue('2028-01-01');
    expect(within(boite).getByLabelText(/^Fin/)).toHaveValue('2028-12-31');
    await u.click(within(boite).getByRole('button', { name: 'Créer l’exercice' }));
    expect(await screen.findByText('Exercice 2028 créé.')).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/exercices')[0]?.corps).toEqual({
      libelle: '2028',
      dateDebut: '2028-01-01',
      dateFin: '2028-12-31',
    });
  });

  it('trésorier (exercice.gerer sans exercice.cloturer) : création sans clôture', async () => {
    const tresorier = utilisateur({
      role: { code: 'tresorier', libelle: 'Trésorier' },
      permissions: ROLES_SYSTEME.tresorier.permissions,
    });
    rendreConsole('/parametres/exercices', { session: session(tresorier) });
    expect(await screen.findByRole('button', { name: 'Nouvel exercice' })).toBeInTheDocument();
    expect(await screen.findByText('2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clôturer/ })).not.toBeInTheDocument();
  });
});

describe('A27 — Association', () => {
  it('enregistre les seuils avec If-Match et seulement les champs modifiés', async () => {
    const { utilisateur: u } = rendreConsole('/parametres/association', { session: session() });
    const seuil = await screen.findByLabelText('Seuil de double validation des dépenses', { exact: false });
    expect(seuil).toHaveValue('100 000');
    await u.clear(seuil);
    await u.type(seuil, '150000');
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Paramètres de l’association enregistrés.')).toBeInTheDocument();
    const [requete] = requetesVers('PATCH', '/v1/association');
    expect(requete?.entetes.get('If-Match')).toBe('"v1"');
    expect(requete?.corps).toEqual({ seuilDoubleValidation: 150000 });

    // Deuxième enregistrement : la nouvelle version renvoyée par le PATCH est utilisée.
    await u.click(screen.getByRole('checkbox', { name: 'Publier le journal public des comptes' }));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(requetesVers('PATCH', '/v1/association')).toHaveLength(2));
    expect(requetesVers('PATCH', '/v1/association')[1]?.entetes.get('If-Match')).toBe('"v2"');
  });

  it('est réservé à association.modifier (secrétaire : accès refusé, carte masquée)', async () => {
    const { utilisateur: u } = rendreConsole('/parametres/association', { session: session_secretaire() });
    expect(await screen.findByRole('heading', { name: 'Accès refusé' })).toBeInTheDocument();
    await u.click(screen.getByRole('link', { name: 'Paramètres' }));
    expect(await screen.findByRole('link', { name: /Utilisateurs et rôles/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Association/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Exercices/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Catégories/ })).not.toBeInTheDocument();
  });

  it('réserve le seuil de double validation au président (RG-ASS-003)', async () => {
    const vice = utilisateur({
      role: { code: 'vice_president', libelle: 'Vice-président' },
      permissions: [...ROLES_SYSTEME.secretaire.permissions, 'association.modifier', 'association.lire'],
    });
    const { utilisateur: u } = rendreConsole('/parametres/association', { session: session(vice) });
    const seuil = await screen.findByLabelText('Seuil de double validation des dépenses', { exact: false });
    expect(seuil).toBeDisabled();
    await u.click(screen.getByRole('checkbox', { name: 'Publier le journal public des comptes' }));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(requetesVers('PATCH', '/v1/association')).toHaveLength(1));
    expect(requetesVers('PATCH', '/v1/association')[0]?.corps).toEqual({ journalPublicActif: true });
  });
});

describe('A29 — Catégories', () => {
  it('crée une catégorie de membres et modifie une catégorie de dépenses', async () => {
    const { utilisateur: u } = rendreConsole('/parametres/categories', { session: session() });
    expect(await screen.findByText('Membre ordinaire')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Nouvelle catégorie' }));
    let boite = await screen.findByRole('dialog', { name: 'Nouvelle catégorie' });
    await u.type(within(boite).getByLabelText(/^Libellé/), 'Membre bienfaiteur');
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Membre bienfaiteur')).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/categories-membres')[0]?.corps).toEqual({
      libelle: 'Membre bienfaiteur',
      description: null,
      actif: true,
    });

    await u.click(screen.getByRole('tab', { name: 'Catégories de dépenses' }));
    await u.click(await screen.findByRole('button', { name: 'Modifier la catégorie Aide sociale' }));
    boite = await screen.findByRole('dialog', { name: 'Modifier la catégorie' });
    await u.click(within(boite).getByRole('checkbox', { name: 'Catégorie active' }));
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer' }));
    const ligne = (await screen.findAllByText('Aide sociale', { selector: 'td' }))[0]!.closest('tr')!;
    expect(await within(ligne).findByText('Inactive')).toBeInTheDocument();
    expect(requetesVers('PATCH', '/v1/categories-depense/cd-2')[0]?.corps).toMatchObject({ actif: false });
  });
});

describe('En-tête — exercice courant', () => {
  it('affiche l’exercice ouvert', async () => {
    rendreConsole('/parametres', { session: session() });
    expect(await screen.findByText('Exercice 2027')).toBeInTheDocument();
  });

  it('reste utilisable si GET /exercices échoue (404 tant que le backend n’est pas livré)', async () => {
    serveur.use(http.get('*/v1/exercices', () => probleme(404, 'INTROUVABLE')));
    rendreConsole('/parametres', { session: session() });
    expect(await screen.findByText('Exercice : information indisponible')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Paramètres' })).toBeInTheDocument();
    expect(requetesVers('GET', '/v1/exercices')).toHaveLength(1);
  });
});

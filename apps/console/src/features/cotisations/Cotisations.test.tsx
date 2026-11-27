import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as csv from '../../shared/csv';
import { etatServeur, requetesVers } from '../../test/serveur';
import {
  CAMPAGNE_ACTIVE_ID,
  CAMPAGNE_BROUILLON_ID,
  etatS3,
  EXERCICE_OUVERT_ID,
} from '../../test/serveurSprint3';
import { session, session_secretaire, session_tresorier } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';

describe('A8 — Campagnes', () => {
  it('liste : type, montant, périodicité, statut et taux ; le menu Cotisations y mène', async () => {
    rendreConsole('/cotisations', { session: session() });
    const tableau = await screen.findByRole('table', { name: 'Campagnes de cotisation' });
    const ligne = within(tableau).getByRole('row', { name: /Cotisation mensuelle 2027/ });
    expect(within(ligne).getByText('Ordinaire')).toBeInTheDocument();
    expect(within(ligne).getByText('Mensuelle')).toBeInTheDocument();
    expect(within(ligne).getByText('50 %')).toBeInTheDocument();
    expect(within(ligne).getByText('Active')).toBeInTheDocument();
    const brouillon = within(tableau).getByRole('row', { name: /Décès du doyen/ });
    expect(within(brouillon).getByText('Exceptionnelle (décès)')).toBeInTheDocument();
    expect(within(brouillon).getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cotisations' })).toHaveAttribute(
      'href',
      '/cotisations/campagnes',
    );
  });

  it('création : aperçu des périodes, motif exigé pour une exceptionnelle, erreur de champ de l’API', async () => {
    const { utilisateur: u, routeur } = rendreConsole('/cotisations/campagnes/nouvelle', {
      session: session_tresorier(),
    });
    await u.type(await screen.findByLabelText(/^Libellé/), 'Cotisation 2027');
    await u.type(screen.getByLabelText(/^Montant par période/), '2500');
    await u.type(screen.getByLabelText(/^Date de début/), '2027-01-01');
    await u.type(screen.getByLabelText(/^Date de fin/), '2027-06-30');
    const apercu = screen.getByRole('region', { name: 'Aperçu des périodes' });
    expect(within(apercu).getByText(/6 période\(s\), soit 15\s000\sFCFA par membre/)).toBeInTheDocument();
    expect(within(apercu).getByText(/Janvier 2027 \(05\/01\/2027\)/)).toBeInTheDocument();

    await u.click(screen.getByRole('radio', { name: 'Exceptionnelle' }));
    await u.click(screen.getByRole('button', { name: 'Créer en brouillon' }));
    expect(await screen.findByText(/Motif obligatoire/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/campagnes')).toHaveLength(0);
    await u.selectOptions(screen.getByLabelText(/^Motif/), 'deces');

    await u.clear(screen.getByLabelText(/^Date de fin/));
    await u.type(screen.getByLabelText(/^Date de fin/), '2028-02-28');
    await u.click(screen.getByRole('button', { name: 'Créer en brouillon' }));
    expect(await screen.findAllByText(/doivent rester dans l’exercice/)).not.toHaveLength(0);

    await u.clear(screen.getByLabelText(/^Date de fin/));
    await u.type(screen.getByLabelText(/^Date de fin/), '2027-06-30');
    await u.click(screen.getByRole('button', { name: 'Créer en brouillon' }));
    await waitFor(() => expect(routeur.state.location.pathname).toMatch(/^\/cotisations\/campagnes\/0190/));
    const envoi = requetesVers('POST', '/v1/campagnes').at(-1)!;
    expect(envoi.corps).toMatchObject({
      libelle: 'Cotisation 2027',
      type: 'exceptionnelle',
      motif: 'deces',
      montant: 2500,
      periodicite: 'mensuelle',
      exerciceId: EXERCICE_OUVERT_ID,
    });
    expect(envoi.entetes.get('Idempotency-Key')).toBeTruthy();
  });

  it('réservée à cotisation.gerer : la secrétaire voit la liste sans bouton de création', async () => {
    rendreConsole('/cotisations/campagnes', { session: session_secretaire() });
    expect(await screen.findByRole('table', { name: 'Campagnes de cotisation' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Nouvelle campagne' })).not.toBeInTheDocument();
  });
});

describe('A9 — Campagne (parcours critique 4 côté console)', () => {
  it('brouillon : aperçu serveur puis activation confirmée → échéancier et statistiques', async () => {
    const { utilisateur: u } = rendreConsole(`/cotisations/campagnes/${CAMPAGNE_BROUILLON_ID}`, {
      session: session_tresorier(),
    });
    expect(
      await screen.findByText(/2 membre\(s\) ciblé\(s\), 2 échéance\(s\) à générer/),
    ).toBeInTheDocument();
    expect(screen.getByText('L’échéancier sera généré à l’activation.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Activer' }));
    const boite = await screen.findByRole('dialog', { name: 'Activer la campagne' });
    expect(within(boite).getByText(/2 échéance\(s\) seront générées pour 2 membre\(s\)/)).toBeInTheDocument();
    await u.click(within(boite).getByRole('button', { name: 'Activer' }));
    expect(
      await screen.findByText('La campagne « Décès du doyen » est active : l’échéancier est généré.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Montant attendu')).toBeInTheDocument();
    const grille = await screen.findByRole('table', { name: 'Échéancier' });
    expect(within(grille).getByRole('link', { name: 'MBR-000001 — Jean Kouassi' })).toBeInTheDocument();
  });

  it('active : statistiques, recouvrement par période, cellule → exonération motivée (président)', async () => {
    const { utilisateur: u } = rendreConsole(`/cotisations/campagnes/${CAMPAGNE_ACTIVE_ID}`, {
      session: session(),
    });
    expect(await screen.findByText('Taux de recouvrement')).toBeInTheDocument();
    const periodes = await screen.findByRole('table', { name: 'Recouvrement par période' });
    expect(within(periodes).getAllByRole('row')).toHaveLength(4);
    expect(within(periodes).getAllByText('2 en retard')).toHaveLength(1);

    const grille = await screen.findByRole('table', { name: 'Échéancier' });
    // Échéance imputée : non modifiable.
    await u.click(await within(grille).findByRole('button', { name: /Jean Kouassi, Janvier 2027 : Payée/ }));
    let boite = await screen.findByRole('dialog', { name: 'Jean Kouassi — Janvier 2027' });
    expect(within(boite).getByText(/n’est plus modifiable/)).toBeInTheDocument();
    await u.click(within(boite).getByRole('button', { name: 'Fermer' }));

    await u.click(within(grille).getByRole('button', { name: /Awa Koné, Mars 2027 : À venir/ }));
    boite = await screen.findByRole('dialog', { name: 'Awa Koné — Mars 2027' });
    await u.click(within(boite).getByRole('button', { name: 'Exonérer' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Exonérer l’échéance' });
    await u.type(within(confirmation).getByLabelText(/^Motif/), 'Décès du conjoint');
    await u.click(within(confirmation).getByRole('button', { name: 'Exonérer' }));
    await waitFor(() =>
      expect(requetesVers('POST', /\/echeances\/.+\/exonerer$/)[0]?.corps).toEqual({
        motif: 'Décès du conjoint',
      }),
    );
    expect(
      await within(grille).findByRole('button', { name: /Awa Koné, Mars 2027 : Exonérée/ }),
    ).toBeInTheDocument();
  });

  it('ajustement d’une échéance par le trésorier (sans le bouton Exonérer)', async () => {
    const { utilisateur: u } = rendreConsole(`/cotisations/campagnes/${CAMPAGNE_ACTIVE_ID}`, {
      session: session_tresorier(),
    });
    const grille = await screen.findByRole('table', { name: 'Échéancier' });
    await u.click(await within(grille).findByRole('button', { name: /Jean Kouassi, Avril 2027 : À venir/ }));
    const boite = await screen.findByRole('dialog', { name: 'Jean Kouassi — Avril 2027' });
    expect(within(boite).queryByRole('button', { name: 'Exonérer' })).not.toBeInTheDocument();
    const montant = within(boite).getByLabelText(/^Montant dû/);
    await u.clear(montant);
    await u.type(montant, '1000');
    await u.click(within(boite).getByRole('button', { name: 'Enregistrer l’ajustement' }));
    await waitFor(() =>
      expect(requetesVers('PATCH', /\/echeances\//)[0]?.corps).toEqual({ montantDu: 1000 }),
    );
  });

  it('ajout de membres avec rattrapage, puis clôture confirmée', async () => {
    const { utilisateur: u } = rendreConsole(`/cotisations/campagnes/${CAMPAGNE_ACTIVE_ID}`, {
      session: session_tresorier(),
    });
    await u.click(await screen.findByRole('button', { name: 'Ajouter des membres' }));
    const boite = await screen.findByRole('dialog', { name: 'Ajouter des membres' });
    await u.type(within(boite).getByLabelText('Rechercher un membre'), 'Kou');
    await u.click(await within(boite).findByLabelText(/Kouassi Jean/));
    await u.click(within(boite).getByLabelText(/^Rattrapage/));
    await u.click(within(boite).getByRole('button', { name: 'Ajouter' }));
    expect(await within(boite).findByText('4 échéance(s) générée(s).')).toBeInTheDocument();
    expect(requetesVers('POST', `/v1/campagnes/${CAMPAGNE_ACTIVE_ID}/membres`)[0]?.corps).toEqual({
      membreIds: [etatServeur.membres[0]!.id],
      rattrapage: true,
    });
    await u.click(within(boite).getByRole('button', { name: 'Fermer' }));

    await u.click(screen.getByRole('button', { name: 'Clôturer' }));
    const conf = await screen.findByRole('dialog', { name: 'Clôturer la campagne' });
    await u.click(within(conf).getByRole('button', { name: 'Clôturer' }));
    expect(
      await screen.findByText('La campagne « Cotisation mensuelle 2027 » est clôturée.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajouter des membres' })).not.toBeInTheDocument();
  });

  it('modification d’une campagne active : seuls libellé, fin et montant sont modifiables ; If-Match envoyé', async () => {
    const { utilisateur: u, routeur } = rendreConsole(
      `/cotisations/campagnes/${CAMPAGNE_ACTIVE_ID}/modifier`,
      {
        session: session_tresorier(),
      },
    );
    const fin = await screen.findByLabelText(/^Date de fin/);
    expect(screen.getByLabelText(/^Périodicité/)).toBeDisabled();
    expect(screen.getByLabelText(/^Date de début/)).toBeDisabled();
    await u.clear(fin);
    await u.type(fin, '2027-06-30');
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(routeur.state.location.pathname).toBe(`/cotisations/campagnes/${CAMPAGNE_ACTIVE_ID}`),
    );
    const patch = requetesVers('PATCH', `/v1/campagnes/${CAMPAGNE_ACTIVE_ID}`)[0]!;
    expect(patch.corps).toEqual({ dateFin: '2027-06-30' });
    expect(patch.entetes.get('If-Match')).toBe('"1"');
    expect(etatS3.campagnes[0]!.nombrePeriodes).toBe(6);
  });
});

describe('A10 — Échéances', () => {
  it('filtre par situation et exporte la sélection', async () => {
    const telecharger = vi.spyOn(csv, 'telechargerFichier').mockImplementation(() => undefined);
    const { utilisateur: u } = rendreConsole('/cotisations/echeances', { session: session() });
    const tableau = await screen.findByRole('table', { name: 'Échéances' });
    expect(within(tableau).getAllByRole('row')).toHaveLength(9);
    await u.selectOptions(screen.getByLabelText('Situation'), 'en_retard');
    // Le tableau est remonté pendant le chargement de la page filtrée : on le relit.
    const filtre = () => screen.getByRole('table', { name: 'Échéances' });
    await waitFor(() => expect(within(filtre()).getAllByRole('row')).toHaveLength(3));
    await u.click(within(filtre()).getAllByRole('checkbox')[1]!);
    await u.click(screen.getByRole('button', { name: 'Exporter la sélection' }));
    const [nom, contenu] = telecharger.mock.calls[0]!;
    expect(nom).toBe('echeances.csv');
    expect(contenu.split('\r\n')[1]).toContain('En retard');
  });
});

describe('A3 — Carte de membre', () => {
  it('télécharge la carte PDF', async () => {
    const telecharger = vi.spyOn(csv, 'telechargerBlob').mockImplementation(() => undefined);
    const m = etatServeur.membres[0]!;
    const { utilisateur: u } = rendreConsole(`/membres/${m.id}`, { session: session() });
    await u.click(await screen.findByRole('button', { name: 'Carte de membre' }));
    await waitFor(() => expect(telecharger).toHaveBeenCalledWith(`carte-${m.numero}.pdf`, expect.anything()));
  });
});

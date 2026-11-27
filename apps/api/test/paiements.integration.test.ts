import { uuidv7 } from '@assoflow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesService } from '../src/infra/files/files.js';
import {
  activerCompte,
  appeler,
  baseDisponible,
  connecterMobile,
  demarrer,
  jetonPourRole,
  telephoneFictif,
  type Banc,
} from './outils-integration.js';

/** Premier jour du mois décalé de `n` mois (UTC), AAAA-MM-JJ. */
function mois(n: number, jour = 1): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, jour)).toISOString().slice(0, 10);
}
const annee = new Date().getUTCFullYear();
const dateSmsDuJour = () => new Date().toISOString().slice(0, 10).split('-').reverse().join('/');

/**
 * Paiements (E4-05 à E4-12) : imputation RG-COT-020/021, numérotation RG-NUM-001, mouvement RG-COT-032,
 * dormance RG-MBR-005, annulation RG-COT-040/041, reçu PDF et SMS (RF-033, RF-034), export des cotisants (RF-039).
 * Parcours critiques 1 (reçus sans trou, SMS en file), 4 (paiement partiel) et 5 (annulation).
 */
describe.skipIf(!baseDisponible)('paiements (intégration PostgreSQL)', () => {
  let b: Banc;
  let files: FilesService;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let jetonA: string;
  let jetonB: string;
  let jetonTresorier: string;
  let jetonSecretaire: string;
  let caisse: string;
  let campagne: string;
  let exceptionnelle: string;

  async function creerMembre(nom: string, extra: Record<string, unknown> = {}) {
    const r = await appeler(b, 'POST', '/v1/membres', {
      jeton: jetonA,
      corps: {
        id: uuidv7(),
        nom,
        prenoms: 'Test',
        telephone: telephoneFictif(),
        consentement: { traitementDonnees: true, canal: 'console' },
        ...extra,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; numero: string; telephone: string | null };
  }

  async function creerCampagne(corps: Record<string, unknown>) {
    const r = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: {
        exerciceId: A.exerciceId,
        libelle: 'Cotisation',
        type: 'ordinaire',
        montant: 2000,
        periodicite: 'mensuelle',
        dateDebut: mois(-2),
        dateFin: mois(1, 28),
        jourEcheance: 10,
        ...corps,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const a = await appeler(b, 'POST', `/v1/campagnes/${r.json().id}/activer`, { jeton: jetonTresorier });
    expect(a.statusCode, a.body).toBe(200);
    return r.json().id as string;
  }

  function corpsPaiement(extra: Record<string, unknown>) {
    return {
      id: uuidv7(),
      montant: 2000,
      mode: 'especes',
      compteId: caisse,
      datePaiement: new Date().toISOString(),
      ...extra,
    };
  }

  async function payer(extra: Record<string, unknown>, jeton = jetonTresorier) {
    const r = await appeler(b, 'POST', '/v1/paiements', { jeton, corps: corpsPaiement(extra) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }

  async function echeances(membreId: string) {
    const r = await appeler(b, 'GET', `/v1/echeances?membreId=${membreId}&limite=200`, { jeton: jetonA });
    return (
      r.json().donnees as {
        campagneId: string;
        dateEcheance: string;
        montantPaye: number;
        situation: string;
      }[]
    )
      .slice()
      .sort((x, y) => x.dateEcheance.localeCompare(y.dateEcheance));
  }

  async function soldeCaisse() {
    const r = await appeler(b, 'GET', '/v1/comptes', { jeton: jetonA });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { id: string; solde: number }[]).find((c) => c.id === caisse)!.solde;
  }

  beforeAll(async () => {
    b = await demarrer();
    files = b.app.get(FilesService);
    const telA = telephoneFictif();
    const telB = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle A Test-Paiements',
      sigle: 'MTP',
      village: 'Dabou',
      region: 'Grands-Ponts',
      president: { telephone: telA, nom: 'Aké', prenoms: 'Paul' },
    });
    await b.associations.creer({
      nom: 'Mutuelle B Test-Paiements',
      village: 'Odienné',
      region: 'Kabadougou',
      president: { telephone: telB, nom: 'Bakayoko', prenoms: 'Sita' },
    });
    await b.owner.query(`UPDATE exercices SET date_debut = $2, date_fin = $3 WHERE id = $1`, [
      A.exerciceId,
      mois(-12),
      mois(12),
    ]);
    caisse = (
      await b.owner.query<{ id: string }>(`SELECT id FROM comptes_tresorerie WHERE association_id = $1`, [
        A.associationId,
      ])
    ).rows[0]!.id;
    await activerCompte(b, telA);
    await activerCompte(b, telB);
    jetonA = (await connecterMobile(b, telA)).accessToken;
    jetonB = (await connecterMobile(b, telB)).accessToken;
    jetonTresorier = await jetonPourRole(b, jetonA, A.roles.tresorier);
    jetonSecretaire = await jetonPourRole(b, jetonA, A.roles.secretaire);
  });
  afterAll(async () => b?.fermer());

  it('E4-05 : imputation par date, campagne ciblée d’abord, avance, mouvement, numéros sans trou, SMS de reçu', async () => {
    const m = await creerMembre('Kone');
    campagne = await creerCampagne({ libelle: 'Mensuelle' });
    exceptionnelle = await creerCampagne({
      libelle: 'Décès',
      type: 'exceptionnelle',
      motif: 'deces',
      montant: 5000,
      periodicite: 'unique',
      dateDebut: mois(0, 2),
      dateFin: mois(0, 2),
    });
    const avant = await soldeCaisse();

    // Campagne ciblée : l'exceptionnelle passe avant les mensualités échues (RG-COT-020 §1).
    const p1 = await payer({ membreId: m.id, montant: 6000, campagneId: exceptionnelle });
    expect(p1.numeroRecu).toBe(`REC-${annee}-000001`);
    const parCampagne = (p: { imputations: { campagneId: string; montant: number }[] }) =>
      p.imputations.map((i) => [i.campagneId, i.montant]);
    expect(parCampagne(p1)).toHaveLength(2);
    expect(parCampagne(p1)).toEqual(
      expect.arrayContaining([
        [exceptionnelle, 5000],
        [campagne, 1000],
      ]),
    );
    expect(p1).toMatchObject({
      annule: false,
      annulable: true,
      compteLibelle: 'Caisse',
      membreNumero: m.numero,
    });
    expect(p1.recuSms).toMatchObject({ statut: 'en_attente', relaisFamille: false });

    // Paiement partiel puis avance au-delà de toutes les échéances (RG-COT-020 §2 à §4).
    const p2 = await payer({ membreId: m.id, montant: 20000 });
    expect(p2.numeroRecu).toBe(`REC-${annee}-000002`);
    const avance = p2.imputations.find((i: { echeanceId: string | null }) => i.echeanceId === null);
    expect(avance.montant).toBe(20000 - (4 * 2000 - 1000));
    const e = await echeances(m.id);
    expect(e.every((x) => x.situation === 'payee')).toBe(true);
    const situation = await appeler(b, 'GET', `/v1/membres/${m.id}/situation`, { jeton: jetonA });
    expect(situation.json()).toMatchObject({ resteDu: 0, avance: avance.montant });

    // RG-COT-032 : entrée en caisse ; RF-034 : SMS remis au fournisseur après le commit.
    expect(await soldeCaisse()).toBe(avant + 26000);
    await files.vider();
    expect(b.sms.dernierMessage(m.telephone!)).toBe(
      `MTP : recu REC-${annee}-000002 - 20 000 FCFA recus de Test le ${dateSmsDuJour()}. Reste du : 0 FCFA.`,
    );
    const detail = await appeler(b, 'GET', `/v1/paiements/${p2.id}`, { jeton: jetonA });
    expect(detail.json().recuSms).toMatchObject({ statut: 'envoyee' });
    const audit = await b.owner.query(
      `SELECT apres FROM audit_log WHERE association_id = $1 AND action = 'paiement.enregistre' AND entite_id = $2`,
      [A.associationId, p2.id],
    );
    expect(audit.rows[0].apres).toMatchObject({ numeroRecu: p2.numeroRecu, montant: 20000 });
  });

  it('idempotence par id, validations (RG-COT-030, RG-COT-031, RG-EXE-002), permissions et isolation', async () => {
    const m = await creerMembre('Yao');
    const corps = corpsPaiement({ membreId: m.id, montant: 1500 });
    const premier = await appeler(b, 'POST', '/v1/paiements', { jeton: jetonTresorier, corps });
    expect(premier.statusCode).toBe(201);
    const rejeu = await appeler(b, 'POST', '/v1/paiements', { jeton: jetonTresorier, corps });
    expect(rejeu.statusCode).toBe(200);
    expect(rejeu.json().numeroRecu).toBe(premier.json().numeroRecu);
    const autre = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonTresorier,
      corps: { ...corps, montant: 1600 },
    });
    expect(autre.statusCode).toBe(409);
    expect(autre.json().code).toBe('CONFLIT_IDEMPOTENCE');

    const eleve = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonTresorier,
      corps: corpsPaiement({ membreId: m.id, montant: 600_000 }),
    });
    expect(eleve.statusCode).toBe(422);
    expect(eleve.json()).toMatchObject({ code: 'CONFIRMATION_REQUISE' });
    const confirme = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonTresorier,
      corps: corpsPaiement({ membreId: m.id, montant: 600_000, confirmationMontantEleve: true }),
    });
    expect(confirme.statusCode, confirme.body).toBe(201);

    const mm = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonTresorier,
      corps: corpsPaiement({ membreId: m.id, mode: 'mobile_money' }),
    });
    expect(mm.statusCode).toBe(422);
    expect(mm.json().erreurs[0].champ).toBe('operateurMm');

    const ferme = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonTresorier,
      corps: corpsPaiement({ membreId: m.id, datePaiement: `${annee - 3}-01-15T10:00:00Z` }),
    });
    expect(ferme.statusCode).toBe(422);
    expect(ferme.json().code).toBe('EXERCICE_FERME');

    expect(
      (
        await appeler(b, 'POST', '/v1/paiements', {
          jeton: jetonSecretaire,
          corps: corpsPaiement({ membreId: m.id }),
        })
      ).statusCode,
    ).toBe(403);
    // Autre tenant : le paiement et le membre sont invisibles.
    expect(
      (await appeler(b, 'GET', `/v1/paiements/${premier.json().id}`, { jeton: jetonB })).statusCode,
    ).toBe(404);
    const croise = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonB,
      corps: corpsPaiement({ membreId: m.id }),
    });
    expect(croise.statusCode).toBe(422);
    expect(croise.json().code).toBe('REFERENCE_INVALIDE');
  });

  it('RG-COT-021 : paiement groupé d’une famille, trié par date puis numéro, reçu au chef (relais RF-060)', async () => {
    const chef = await creerMembre('Famille-Chef');
    const familleId = uuidv7();
    const f = await appeler(b, 'POST', '/v1/familles', {
      jeton: jetonA,
      corps: { id: familleId, nom: 'Diabaté', chefFamilleId: chef.id },
    });
    expect(f.statusCode, f.body).toBe(201);
    const enfant = await creerMembre('Famille-Enfant', { telephone: null, familleId });
    await appeler(b, 'POST', `/v1/campagnes/${campagne}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [chef.id, enfant.id], rattrapage: true },
    });
    const p = await payer({ familleId, montant: 3000 });
    // Première échéance (date la plus ancienne) du chef, puis celle de l'enfant (numéro suivant).
    const lignes = p.imputations.map((i: { membreId: string; montant: number }) => [i.membreId, i.montant]);
    expect(lignes).toHaveLength(2);
    expect(lignes).toEqual(
      expect.arrayContaining([
        [chef.id, 2000],
        [enfant.id, 1000],
      ]),
    );
    expect(p).toMatchObject({ familleNom: 'Diabaté', membreId: null });
    await files.vider();
    expect(b.sms.dernierMessage(chef.telephone!)).toContain('recus de famille Diabaté');
    // L'historique de l'enfant montre le paiement groupé qui l'a crédité.
    const h = await appeler(b, 'GET', `/v1/membres/${enfant.id}/historique`, { jeton: jetonA });
    expect(h.json().donnees.some((x: { type: string }) => x.type === 'paiement')).toBe(true);
    const liste = await appeler(b, 'GET', `/v1/paiements?membreId=${enfant.id}`, { jeton: jetonA });
    expect(liste.json().donnees.map((x: { id: string }) => x.id)).toContain(p.id);
  });

  it('RG-MBR-005 : un membre dormant redevient actif à son premier paiement', async () => {
    const m = await creerMembre('Dormeur', { statutAdhesion: 'dormant' });
    await payer({ membreId: m.id, montant: 500 });
    const r = await appeler(b, 'GET', `/v1/membres/${m.id}`, { jeton: jetonA });
    expect(r.json().statutAdhesion).toBe('actif');
  });

  it('RG-COT-040/041 : annulation par contre-écriture, droits du trésorier, solde du membre recalculé', async () => {
    const m = await creerMembre('Annule');
    await appeler(b, 'POST', `/v1/campagnes/${campagne}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [m.id], rattrapage: true },
    });
    const p = await payer({ membreId: m.id, montant: 3000 });
    const duPresident = await payer({ membreId: m.id, montant: 1000 }, jetonA);
    const avant = await soldeCaisse();

    // Le trésorier n'annule pas le paiement d'un autre saisisseur (RG-COT-041).
    expect(duPresident.annulable).toBe(true);
    const vuParTresorier = await appeler(b, 'GET', `/v1/paiements/${duPresident.id}`, {
      jeton: jetonTresorier,
    });
    expect(vuParTresorier.json().annulable).toBe(false);
    const refus = await appeler(b, 'POST', `/v1/paiements/${duPresident.id}/annuler`, {
      jeton: jetonTresorier,
      corps: { motif: 'Erreur de saisie' },
    });
    expect(refus.statusCode).toBe(403);
    // Plus de 48 h : refusé au trésorier même pour son propre paiement.
    await b.owner.query(`ALTER TABLE paiements DISABLE TRIGGER paiements_append_only`);
    await b.owner.query(`UPDATE paiements SET recu_serveur_at = now() - interval '49 hours' WHERE id = $1`, [
      p.id,
    ]);
    const vieux = await appeler(b, 'POST', `/v1/paiements/${p.id}/annuler`, {
      jeton: jetonTresorier,
      corps: { motif: 'Erreur de saisie' },
    });
    await b.owner.query(`UPDATE paiements SET recu_serveur_at = now() WHERE id = $1`, [p.id]);
    await b.owner.query(`ALTER TABLE paiements ENABLE TRIGGER paiements_append_only`);
    expect(vieux.statusCode).toBe(403);

    const sansMotif = await appeler(b, 'POST', `/v1/paiements/${p.id}/annuler`, {
      jeton: jetonTresorier,
      corps: { motif: '' },
    });
    expect(sansMotif.statusCode).toBe(422);
    const a = await appeler(b, 'POST', `/v1/paiements/${p.id}/annuler`, {
      jeton: jetonTresorier,
      corps: { motif: 'Erreur de saisie' },
    });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ type: 'annulation', annulePaiementId: p.id, motif: 'Erreur de saisie' });
    expect(a.json().numeroRecu).toMatch(new RegExp(`^REC-${annee}-\\d{6}$`));
    expect(a.json().imputations.every((i: { montant: number }) => i.montant < 0)).toBe(true);
    expect(await soldeCaisse()).toBe(avant - 3000);

    const original = await appeler(b, 'GET', `/v1/paiements/${p.id}`, { jeton: jetonA });
    expect(original.json()).toMatchObject({ annule: true, annulable: false });
    expect(original.json().annulation).toMatchObject({ id: a.json().id, motif: 'Erreur de saisie' });
    const deux = await appeler(b, 'POST', `/v1/paiements/${p.id}/annuler`, {
      jeton: jetonA,
      corps: { motif: 'Encore' },
    });
    expect(deux.statusCode).toBe(409);
    const annulAnnul = await appeler(b, 'POST', `/v1/paiements/${a.json().id}/annuler`, {
      jeton: jetonA,
      corps: { motif: 'Encore' },
    });
    expect(annulAnnul.statusCode).toBe(409);

    // Situation recalculée : seul le paiement du président reste imputé.
    const s = await appeler(b, 'GET', `/v1/membres/${m.id}/situation`, { jeton: jetonA });
    expect(s.json().totalPaye).toBe(1000);
    // Liste : sans `inclureAnnules`, ni le paiement annulé ni l'annulation.
    const liste = await appeler(b, 'GET', `/v1/paiements?membreId=${m.id}`, { jeton: jetonA });
    expect(liste.json().donnees.map((x: { id: string }) => x.id)).toEqual([duPresident.id]);
    const tout = await appeler(b, 'GET', `/v1/paiements?membreId=${m.id}&inclureAnnules=true`, {
      jeton: jetonA,
    });
    expect(tout.json().donnees).toHaveLength(3);
    await files.vider();
    expect(b.sms.dernierMessage(m.telephone!)).toContain('a ete annule. Motif : Erreur de saisie.');
  });

  it('RG-COT-022 : une avance annulée n’est plus imputée aux nouvelles échéances', async () => {
    const m = await creerMembre('AvanceAnnulee');
    const p = await payer({ membreId: m.id, montant: 4000 });
    expect(p.imputations).toEqual([expect.objectContaining({ echeanceId: null, montant: 4000 })]);
    const a = await appeler(b, 'POST', `/v1/paiements/${p.id}/annuler`, {
      jeton: jetonTresorier,
      corps: { motif: 'Doublon' },
    });
    expect(a.statusCode).toBe(201);
    await appeler(b, 'POST', `/v1/campagnes/${campagne}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [m.id], rattrapage: true },
    });
    const e = await echeances(m.id);
    expect(e.length).toBeGreaterThan(0);
    expect(e.every((x) => x.montantPaye === 0)).toBe(true);
  });

  it('E4-11 : reçu PDF et renvoi du reçu (RF-033, RF-034, RG-NUM-002)', async () => {
    const m = await creerMembre('Recu');
    const p = await payer({ membreId: m.id, montant: 2500, numeroRecuProvisoire: 'T02-000145' });
    const pdf = await appeler(b, 'GET', `/v1/paiements/${p.id}/recu`, { jeton: jetonSecretaire });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    const renvoi = await appeler(b, 'POST', `/v1/paiements/${p.id}/renvoyer-recu`, { jeton: jetonTresorier });
    expect(renvoi.statusCode, renvoi.body).toBe(202);
    expect(renvoi.json()).toMatchObject({ modeleCode: 'recu_paiement', statut: 'en_attente', priorite: 1 });
    await files.vider();
    expect(b.sms.dernierMessage(m.telephone!)).toContain(`${p.numeroRecu} (prov. T02-000145)`);
    expect(b.sms.messagesPour(m.telephone!)).toHaveLength(2);

    const refus = await creerMembre('SansSms', { canalPrefere: 'aucun' });
    const p2 = await payer({ membreId: refus.id, montant: 500 });
    expect(p2.recuSms).toBeNull();
    const r = await appeler(b, 'POST', `/v1/paiements/${p2.id}/renvoyer-recu`, { jeton: jetonTresorier });
    expect(r.statusCode).toBe(422);
    expect(r.json().erreurs[0].code).toBe('CONTACT_REQUIS');
  });

  it('E4-12 : export Excel des cotisants en tâche, URL de lecture à la fin', async () => {
    const r = await appeler(b, 'POST', '/v1/rapports', {
      jeton: jetonTresorier,
      corps: { type: 'export_cotisants', format: 'xlsx', parametres: { campagneId: campagne } },
    });
    expect(r.statusCode, r.body).toBe(202);
    await files.vider();
    const t = await appeler(b, 'GET', `/v1/taches/${r.json().id}`, { jeton: jetonTresorier });
    expect(t.json()).toMatchObject({ statut: 'terminee', type: 'export_cotisants' });
    expect(t.json().resultat.lignes).toBeGreaterThan(0);
    expect(t.json().resultat.url).toMatch(/^https?:\/\//);
    expect(t.json().resultat._cle).toBeUndefined();
    const indispo = await appeler(b, 'POST', '/v1/rapports', {
      jeton: jetonTresorier,
      corps: { type: 'rapport_financier', format: 'pdf' },
    });
    expect(indispo.statusCode).toBe(422);
  });

  it('RF-043 : création de compte, libellé unique, permission, paiement mobile money sur ce compte', async () => {
    const r = await appeler(b, 'POST', '/v1/comptes', {
      jeton: jetonTresorier,
      corps: {
        type: 'mobile_money',
        libelle: 'Orange Money',
        banqueOuOperateur: 'Orange',
        soldeInitial: 1000,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ solde: 1000, actif: true });
    const doublon = await appeler(b, 'POST', '/v1/comptes', {
      jeton: jetonTresorier,
      corps: { type: 'mobile_money', libelle: 'Orange Money' },
    });
    expect(doublon.statusCode).toBe(422);
    expect(
      (
        await appeler(b, 'POST', '/v1/comptes', {
          jeton: jetonSecretaire,
          corps: { type: 'caisse', libelle: 'X' },
        })
      ).statusCode,
    ).toBe(403);
    const m = await creerMembre('Wave');
    const p = await payer({
      membreId: m.id,
      mode: 'mobile_money',
      operateurMm: 'orange',
      referenceExterne: 'OM-123',
      compteId: r.json().id,
    });
    expect(p).toMatchObject({ compteLibelle: 'Orange Money', operateurMm: 'orange' });
  });
});

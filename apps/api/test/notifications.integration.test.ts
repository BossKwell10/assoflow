import { uuidv7 } from '@assoflow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesService } from '../src/infra/files/files.js';
import { JournalSms } from '../src/infra/sms/journal-sms.js';
import { SimulateurSms } from '../src/infra/sms/simulateur-sms.js';
import { DiffusionService } from '../src/modules/notifications/diffusion.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
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

const SECRET = 'secret-webhook-de-test-0123456789';
const jour = (decalage: number) => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
const mois = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
};

/**
 * Notifications (E6-01 à E6-08) : outbox et reprise, bascule entre fournisseurs et accusés de remise (docs/06 §4.1),
 * quotas et alertes (§4.3), modèles personnalisés (§5), rappels regroupés RG-COT-050, relais par le chef de famille
 * (RF-060), relance manuelle (A10) et convocation d'AG (RF-063).
 */
describe.skipIf(!baseDisponible)('notifications SMS (intégration PostgreSQL)', () => {
  let b: Banc;
  let files: FilesService;
  let notifications: NotificationsService;
  let diffusion: DiffusionService;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let telPresident: string;
  let jetonA: string;
  let jetonTresorier: string;
  let jetonSecretaire: string;
  let caisse: string;
  // Codes propres à l'exécution : le disjoncteur (taux de remise sur 1 h, tous tenants) ne voit pas les envois
  // sans accusé des exécutions précédentes.
  const suffixe = Math.random().toString(36).slice(2, 8);
  const simA = new SimulateurSms(`sim_a_${suffixe}`, true, SECRET);
  const simB = new SimulateurSms(`sim_b_${suffixe}`, true, SECRET);

  async function creerMembre(nom: string, extra: Record<string, unknown> = {}) {
    const r = await appeler(b, 'POST', '/v1/membres', {
      jeton: jetonA,
      corps: {
        id: uuidv7(),
        nom,
        prenoms: nom,
        telephone: telephoneFictif(),
        consentement: { traitementDonnees: true, canal: 'console' },
        ...extra,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; telephone: string | null };
  }

  async function campagneUnique(date: string, membreIds: string[], montant = 3000) {
    const c = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: {
        exerciceId: A.exerciceId,
        libelle: `Unique ${date}`,
        type: 'exceptionnelle',
        motif: 'evenement',
        montant,
        periodicite: 'unique',
        dateDebut: date,
        dateFin: date,
      },
    });
    expect(c.statusCode, c.body).toBe(201);
    await appeler(b, 'POST', `/v1/campagnes/${c.json().id}/activer`, { jeton: jetonTresorier });
    // L'activation cible tous les membres actifs : on garde le périmètre du test par l'ajout explicite.
    await appeler(b, 'POST', `/v1/campagnes/${c.json().id}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds, rattrapage: true },
    });
    return c.json().id as string;
  }

  async function payer(membreId: string, montant = 1000) {
    const r = await appeler(b, 'POST', '/v1/paiements', {
      jeton: jetonTresorier,
      corps: {
        id: uuidv7(),
        membreId,
        montant,
        mode: 'especes',
        compteId: caisse,
        datePaiement: new Date().toISOString(),
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }

  async function notification(id: string) {
    const r = await b.owner.query(`SELECT * FROM notifications WHERE id = $1`, [id]);
    return r.rows[0];
  }

  beforeAll(async () => {
    b = await demarrer();
    files = b.app.get(FilesService);
    notifications = b.app.get(NotificationsService);
    diffusion = b.app.get(DiffusionService);
    b.routeurSms.utiliser([simA, simB]);
    telPresident = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle Test-Notifications',
      sigle: 'MTN',
      village: 'Bouaflé',
      region: 'Marahoué',
      president: { telephone: telPresident, nom: 'Gbagbo', prenoms: 'Ange' },
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
    // Les OTP passent aussi par le routeur : le simulateur garde les codes comme le journal.
    const otp = { dernierCode: (t: string) => simA.dernierCode(t) ?? simB.dernierCode(t) };
    (b as { sms: unknown }).sms = otp as unknown as JournalSms;
    await activerCompte(b, telPresident);
    jetonA = (await connecterMobile(b, telPresident)).accessToken;
    jetonTresorier = await jetonPourRole(b, jetonA, A.roles.tresorier);
    jetonSecretaire = await jetonPourRole(b, jetonA, A.roles.secretaire);
  });
  afterAll(async () => b?.fermer());

  it('E6-02 : bascule sur le second fournisseur en cas de panne, accusé de remise par webhook', async () => {
    const m = await creerMembre('Bascule');
    simA.panne = 'transitoire';
    try {
      const p = await payer(m.id);
      await files.vider();
      const n = await notification(p.recuSms.notificationId);
      expect(n).toMatchObject({ statut: 'envoyee', fournisseur: simB.code, tentatives: 1 });
      expect(simB.dernierMessage(m.telephone!)).toContain(p.numeroRecu);

      // Webhook : jeton invalide → 404 ; accusé valide → remise.
      const faux = await appeler(b, 'POST', `/v1/webhooks/sms/${simB.code}`, {
        corps: { id: n.fournisseur_msg_id, statut: 'remise' },
        entetes: { 'x-webhook-token': 'mauvais-jeton-mauvais-jeton-0000' },
      });
      expect(faux.statusCode).toBe(404);
      const ok = await appeler(b, 'POST', `/v1/webhooks/sms/${simB.code}`, {
        corps: { id: n.fournisseur_msg_id, statut: 'remise', date: new Date().toISOString() },
        entetes: { 'x-webhook-token': SECRET },
      });
      expect(ok.statusCode).toBe(204);
      expect(await notification(n.id)).toMatchObject({ statut: 'remise' });
      expect((await notification(n.id)).remise_at).not.toBeNull();
      const inconnu = await appeler(b, 'POST', '/v1/webhooks/sms/inconnu', { corps: {} });
      expect(inconnu.statusCode).toBe(404);
    } finally {
      simA.panne = 'aucune';
    }
  });

  it('E6-01 : panne de tous les fournisseurs → nouvel essai, puis échec définitif après 5 tentatives', async () => {
    const m = await creerMembre('Panne');
    simA.panne = 'transitoire';
    simB.panne = 'transitoire';
    try {
      const p = await payer(m.id);
      await files.vider();
      const id = p.recuSms.notificationId as string;
      expect(await notification(id)).toMatchObject({ statut: 'en_attente', tentatives: 1 });
      expect((await notification(id)).derniere_erreur).toContain('panne simulée');
      for (let i = 2; i <= 4; i++) {
        await expect(notifications.envoyer(id, A.associationId)).rejects.toThrow();
      }
      expect(await notifications.envoyer(id, A.associationId)).toBe('echec');
      expect(await notification(id)).toMatchObject({ statut: 'echec', tentatives: 5 });
      // Une notification terminée n'est jamais renvoyée.
      expect(await notifications.envoyer(id, A.associationId)).toBeNull();
    } finally {
      simA.panne = 'aucune';
      simB.panne = 'aucune';
    }
  });

  it('E6-01 : reprise des lignes en attente orphelines (crash entre commit et mise en file)', async () => {
    const m = await creerMembre('Orphelin');
    const p = await payer(m.id);
    await files.vider();
    // Simule une ligne restée en attente depuis 3 min sans job.
    const orpheline = await b.owner.query<{ id: string }>(
      `INSERT INTO notifications (association_id, membre_id, canal, modele_code, destinataire, contenu, priorite,
                                  created_at)
       VALUES ($1, $2, 'sms', 'recu_paiement', $3, 'Test reprise', 1, now() - interval '3 minutes') RETURNING id`,
      [A.associationId, m.id, m.telephone],
    );
    expect(p.recuSms).not.toBeNull();
    expect(await notifications.reprendre()).toBeGreaterThanOrEqual(1);
    await files.vider();
    expect(await notification(orpheline.rows[0]!.id)).toMatchObject({ statut: 'envoyee' });
  });

  it('E6-05 : quota mensuel — rappels hors quota, reçus jamais bloqués, alertes 80 % puis 100 % au président', async () => {
    const m = await creerMembre('Quota');
    await campagneUnique(jour(-7), [m.id]);
    await b.owner.query(`UPDATE associations SET quota_sms_mensuel = 10 WHERE id = $1`, [A.associationId]);
    await b.owner.query(
      `INSERT INTO consommation_sms (association_id, mois, unites)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 8)
       ON CONFLICT (association_id, mois) DO UPDATE SET unites = 8, alerte_80_at = NULL, alerte_100_at = NULL`,
      [A.associationId],
    );
    expect(await diffusion.alerterQuota(A.associationId)).toBe(1);
    await files.vider();
    expect(simA.dernierMessage(telPresident)).toContain(
      '80% du quota SMS mensuel de Mutuelle Test-Notifications',
    );
    expect(await diffusion.alerterQuota(A.associationId)).toBeNull();

    await b.owner.query(
      `UPDATE consommation_sms SET unites = 10 WHERE association_id = $1
          AND mois = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
      [A.associationId],
    );
    const r = await diffusion.genererRappels(A.associationId);
    expect(r.notifications).toBeGreaterThanOrEqual(1);
    await files.vider();
    const rappel = await b.owner.query(
      `SELECT statut FROM notifications WHERE association_id = $1 AND membre_id = $2 AND modele_code = 'rappel_retard'`,
      [A.associationId, m.id],
    );
    expect(rappel.rows[0]).toMatchObject({ statut: 'hors_quota' });
    // Le reçu (prioritaire) part quand même et reste compté.
    const p = await payer(m.id, 500);
    await files.vider();
    expect(await notification(p.recuSms.notificationId)).toMatchObject({ statut: 'envoyee' });
    expect(await diffusion.alerterQuota(A.associationId)).toBe(1);
    const conso = await appeler(b, 'GET', '/v1/sms/consommation', { jeton: jetonTresorier });
    expect(conso.statusCode).toBe(200);
    expect(conso.json()).toMatchObject({ quota: 10, horsQuota: expect.any(Number) });
    expect(conso.json().unites).toBeGreaterThan(10);
    expect(conso.json().horsQuota).toBeGreaterThanOrEqual(1);
    await b.owner.query(`UPDATE associations SET quota_sms_mensuel = 100000 WHERE id = $1`, [
      A.associationId,
    ]);
  });

  it('RG-COT-050 : rappels J-7, J-1, J+7 regroupés (un message par membre et par jour), exclusions, relais famille', async () => {
    const m = await creerMembre('Rappel');
    const suspendu = await creerMembre('Suspendu');
    const muet = await creerMembre('Muet', { canalPrefere: 'aucun' });
    const chef = await creerMembre('Chef');
    const familleId = uuidv7();
    await appeler(b, 'POST', '/v1/familles', {
      jeton: jetonA,
      corps: { id: familleId, nom: 'Koffi', chefFamilleId: chef.id },
    });
    const sansTel = await creerMembre('SansTel', { telephone: null, familleId });
    const cibles = [m.id, suspendu.id, muet.id, sansTel.id];
    await campagneUnique(jour(7), cibles, 1000);
    await campagneUnique(jour(-7), cibles, 2500);
    await campagneUnique(jour(3), cibles, 9999); // hors J-7 / J-1 / J+7 : pas de rappel
    await appeler(b, 'POST', `/v1/membres/${suspendu.id}/suspendre`, {
      jeton: jetonA,
      corps: { motif: 'Test' },
    });

    const premiere = await diffusion.genererRappels(A.associationId);
    await files.vider();
    const textes = simA.messagesPour(m.telephone!);
    expect(textes.filter((t) => t.includes('rappel') || t.includes('retard'))).toHaveLength(1);
    const date = jour(-7).split('-').reverse().join('/');
    expect(textes.at(-1)).toBe(
      `MTN : votre cotisation de 3 500 FCFA est en retard depuis le ${date}. Contactez le tresorier.`,
    );
    expect(simA.messagesPour(suspendu.telephone!)).toHaveLength(0);
    expect(simA.messagesPour(muet.telephone!)).toHaveLength(0);
    // RF-060 : le membre sans téléphone est joint par son chef de famille.
    expect(simA.dernierMessage(chef.telephone!)).toContain('en retard depuis le');
    const relais = await b.owner.query(
      `SELECT relais_famille FROM notifications WHERE membre_id = $1 AND modele_code = 'rappel_retard'`,
      [sansTel.id],
    );
    expect(relais.rows[0]).toMatchObject({ relais_famille: true });
    expect(premiere.notifications).toBeGreaterThanOrEqual(2);
    // Même jour : aucun doublon.
    const seconde = await diffusion.genererRappels(A.associationId);
    expect(seconde.notifications).toBe(0);
    expect(seconde.dejaEnvoyees).toBeGreaterThanOrEqual(2);
  });

  it('A10 : relance manuelle des échéances en retard, une par membre et par jour', async () => {
    const m = await creerMembre('Relance');
    const campagneId = await campagneUnique(jour(-20), [m.id], 4000);
    const e = await appeler(b, 'GET', `/v1/echeances?campagneId=${campagneId}&membreId=${m.id}`, {
      jeton: jetonA,
    });
    const ids = e.json().donnees.map((x: { id: string }) => x.id);
    expect(
      (
        await appeler(b, 'POST', '/v1/echeances/relancer', {
          jeton: jetonSecretaire,
          corps: { echeanceIds: ids },
        })
      ).statusCode,
    ).toBe(403);
    const r = await appeler(b, 'POST', '/v1/echeances/relancer', {
      jeton: jetonTresorier,
      corps: { echeanceIds: ids },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ notifications: 1, dejaEnvoyees: 0, sansContact: 0, unitesEstimees: 1 });
    const encore = await appeler(b, 'POST', '/v1/echeances/relancer', {
      jeton: jetonTresorier,
      corps: { echeanceIds: ids },
    });
    expect(encore.json()).toMatchObject({ notifications: 0, dejaEnvoyees: 1 });
    await files.vider();
    expect(simA.dernierMessage(m.telephone!)).toContain('4 000 FCFA est en retard');
  });

  it('E6-06 : modèles personnalisés (texte seulement), retour au modèle global, historique', async () => {
    const liste = await appeler(b, 'GET', '/v1/modeles-notification', { jeton: jetonSecretaire });
    expect(liste.statusCode).toBe(200);
    const codes = liste.json().map((x: { code: string }) => x.code);
    expect(codes).toContain('recu_paiement');
    expect(codes).not.toContain('otp');
    expect((await appeler(b, 'GET', '/v1/modeles-notification', { jeton: jetonTresorier })).statusCode).toBe(
      403,
    );

    const inconnue = await appeler(b, 'PUT', '/v1/modeles-notification/recu_paiement/sms', {
      jeton: jetonSecretaire,
      corps: { contenu: 'Merci {{membre.telephone}}' },
    });
    expect(inconnue.statusCode).toBe(422);
    expect(inconnue.json().erreurs[0].code).toBe('VARIABLE_INCONNUE');
    expect(
      (
        await appeler(b, 'PUT', '/v1/modeles-notification/otp/sms', {
          jeton: jetonSecretaire,
          corps: { contenu: 'Code {{code}}' },
        })
      ).statusCode,
    ).toBe(404);
    const perso = await appeler(b, 'PUT', '/v1/modeles-notification/recu_paiement/sms', {
      jeton: jetonSecretaire,
      corps: {
        contenu: 'Merci {{membre.prenoms}} : recu {{paiement.numero_recu}} de {{paiement.montant}} FCFA.',
      },
    });
    expect(perso.statusCode, perso.body).toBe(200);
    expect(perso.json()).toMatchObject({ personnalise: true, unites: 1 });

    const m = await creerMembre('Modele');
    const p = await payer(m.id, 7000);
    await files.vider();
    expect(simA.dernierMessage(m.telephone!)).toBe(`Merci Modele : recu ${p.numeroRecu} de 7 000 FCFA.`);

    const retour = await appeler(b, 'DELETE', '/v1/modeles-notification/recu_paiement/sms', {
      jeton: jetonSecretaire,
    });
    expect(retour.statusCode).toBe(204);
    const apres = await appeler(b, 'GET', '/v1/modeles-notification', { jeton: jetonSecretaire });
    expect(apres.json().find((x: { code: string }) => x.code === 'recu_paiement').personnalise).toBe(false);

    const h = await appeler(b, 'GET', `/v1/notifications?membreId=${m.id}&modele=recu_paiement`, {
      jeton: jetonSecretaire,
    });
    expect(h.statusCode).toBe(200);
    expect(h.json().donnees[0]).toMatchObject({
      statut: 'envoyee',
      fournisseur: simA.code,
      relaisFamille: false,
    });
    expect(h.json().donnees[0].destinataireMasque).toContain('••');
  });

  it('E6-08 : convocation d’AG par SMS, une par membre et par réunion', async () => {
    const m = await creerMembre('Convoque');
    const r = await appeler(b, 'POST', '/v1/reunions', {
      jeton: jetonSecretaire,
      corps: {
        type: 'ag_ordinaire',
        titre: 'Assemblee generale',
        debut: `${jour(10)}T10:00:00Z`,
        lieu: 'Foyer',
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const c = await appeler(b, 'POST', `/v1/reunions/${r.json().id}/convoquer`, {
      jeton: jetonSecretaire,
      corps: { cible: { membres: [m.id] } },
    });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ notifications: 1, dejaEnvoyees: 0 });
    const tous = await appeler(b, 'POST', `/v1/reunions/${r.json().id}/convoquer`, {
      jeton: jetonSecretaire,
      corps: { cible: { tous: true } },
    });
    expect(tous.json().dejaEnvoyees).toBe(1);
    await files.vider();
    const date = jour(10).split('-').reverse().join('/');
    expect(simA.dernierMessage(m.telephone!)).toBe(
      `MTN : Assemblee generale le ${date} a 10:00 a Foyer. Ordre du jour dans l'app.`,
    );
    const liste = await appeler(b, 'GET', '/v1/reunions', { jeton: jetonTresorier });
    expect(liste.json().donnees[0]).toMatchObject({ id: r.json().id, convoques: expect.any(Number) });
    const passee = await appeler(b, 'POST', '/v1/reunions', {
      jeton: jetonSecretaire,
      corps: { type: 'bureau', titre: 'Passee', debut: `${jour(-1)}T10:00:00Z` },
    });
    const refus = await appeler(b, 'POST', `/v1/reunions/${passee.json().id}/convoquer`, {
      jeton: jetonSecretaire,
      corps: { cible: { tous: true } },
    });
    expect(refus.statusCode).toBe(409);
  });
});

import { uuidv7 } from '@assoflow/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** Premier jour du mois décalé de `n` mois par rapport au mois courant (UTC), AAAA-MM-JJ. */
function mois(n: number, jour = 1): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, jour)).toISOString().slice(0, 10);
}
const aujourdhui = () => new Date().toISOString().slice(0, 10);

/**
 * Campagnes et échéancier (E4-01 à E4-04) : RG-COT-001, 010 à 015, 022 ; parcours critique 4 (le paiement
 * partiel est simulé en base jusqu'au module paiements du sprint 4).
 */
describe.skipIf(!baseDisponible)('campagnes et échéances (intégration PostgreSQL)', () => {
  let b: Banc;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let jetonA: string;
  let jetonB: string;
  let jetonTresorier: string;
  let jetonSecretaire: string;
  let caisseA: string;
  let catJeunes: string;
  const membres: Record<string, string> = {};

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
    return r.json().id as string;
  }

  function corpsCampagne(extra: Record<string, unknown> = {}) {
    return {
      exerciceId: A.exerciceId,
      libelle: 'Cotisation mensuelle',
      type: 'ordinaire',
      montant: 2000,
      periodicite: 'mensuelle',
      dateDebut: mois(-3),
      dateFin: mois(3, 28),
      jourEcheance: 10,
      ...extra,
    };
  }

  async function creerCampagne(extra: Record<string, unknown> = {}, jeton = jetonTresorier) {
    const r = await appeler(b, 'POST', '/v1/campagnes', { jeton, corps: corpsCampagne(extra) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; etag: string; statut: string; nombrePeriodes: number };
  }

  /** Paiement simulé (le module paiements arrive au sprint 4) : ligne de paiement + imputations données. */
  async function payer(membreId: string, imputations: { echeanceId: string | null; montant: number }[]) {
    const id = uuidv7();
    const total = imputations.reduce((s, i) => s + i.montant, 0);
    await b.owner.query(
      `INSERT INTO paiements (id, association_id, numero_recu, membre_id, montant, mode, compte_id, date_paiement,
                              saisi_par, exercice_id)
       VALUES ($1, $2, $3, $4, $5, 'especes', $6, now(), $7, $8)`,
      [
        id,
        A.associationId,
        `REC-T-${randomUUID().slice(0, 8)}`,
        membreId,
        total,
        caisseA,
        A.presidentUserId,
        A.exerciceId,
      ],
    );
    for (const i of imputations) {
      await b.owner.query(
        `INSERT INTO imputations_paiement (association_id, paiement_id, echeance_id, membre_id, montant)
         VALUES ($1, $2, $3, $4, $5)`,
        [A.associationId, id, i.echeanceId, membreId, i.montant],
      );
    }
    return id;
  }

  async function echeancesDe(campagneId: string, membreId: string) {
    const r = await appeler(
      b,
      'GET',
      `/v1/echeances?campagneId=${campagneId}&membreId=${membreId}&limite=200`,
      {
        jeton: jetonA,
      },
    );
    expect(r.statusCode, r.body).toBe(200);
    return r.json().donnees as {
      id: string;
      numeroPeriode: number;
      dateEcheance: string;
      montantDu: number;
      montantPaye: number;
      situation: string;
      imputee: boolean;
    }[];
  }

  beforeAll(async () => {
    b = await demarrer();
    const telA = telephoneFictif();
    const telB = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle A Test-Campagnes',
      village: 'Dabou',
      region: 'Grands-Ponts',
      president: { telephone: telA, nom: 'Aké', prenoms: 'Paul' },
    });
    await b.associations.creer({
      nom: 'Mutuelle B Test-Campagnes',
      village: 'Odienné',
      region: 'Kabadougou',
      president: { telephone: telB, nom: 'Bakayoko', prenoms: 'Sita' },
    });
    // Exercice courant élargi pour des dates passées et futures déterministes.
    await b.owner.query(`UPDATE exercices SET date_debut = $2, date_fin = $3 WHERE id = $1`, [
      A.exerciceId,
      mois(-12),
      mois(12),
    ]);
    caisseA = (
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
    const cat = await appeler(b, 'POST', '/v1/categories-membres', {
      jeton: jetonA,
      corps: { libelle: 'Jeunes' },
    });
    catJeunes = cat.json().id;
    membres.actif = await creerMembre('Actif');
    membres.dormant = await creerMembre('Dormant', { statutAdhesion: 'dormant' });
    membres.honoraire = await creerMembre('Honoraire', { statutAdhesion: 'honoraire' });
    membres.suspendu = await creerMembre('Suspendu');
    await appeler(b, 'POST', `/v1/membres/${membres.suspendu}/suspendre`, {
      jeton: jetonA,
      corps: { motif: 'Absences répétées' },
    });
    membres.jeune = await creerMembre('Jeune', { categorieId: catJeunes });
    membres.avance = await creerMembre('Avance');
  });
  afterAll(async () => b?.fermer());

  it('RG-COT-001 : création en brouillon, validations (exercice, motif, catégories), idempotence, permissions', async () => {
    const hors = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: corpsCampagne({ dateFin: mois(14) }),
    });
    expect(hors.statusCode).toBe(422);
    expect(hors.json().erreurs[0]).toMatchObject({ champ: 'dateFin', code: 'HORS_EXERCICE' });
    const sansMotif = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: corpsCampagne({ type: 'exceptionnelle' }),
    });
    expect(sansMotif.statusCode).toBe(422);
    expect(sansMotif.json().erreurs[0].champ).toBe('motif');
    const cat = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: corpsCampagne({ categoriesCibles: [randomUUID()] }),
    });
    expect(cat.json().code).toBe('REFERENCE_INVALIDE');
    expect(
      (await appeler(b, 'POST', '/v1/campagnes', { jeton: jetonSecretaire, corps: corpsCampagne() }))
        .statusCode,
    ).toBe(403);

    const cle = randomUUID();
    const premiere = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: corpsCampagne({ libelle: 'Idempotente' }),
      entetes: { 'idempotency-key': cle },
    });
    const rejeu = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: corpsCampagne({ libelle: 'Idempotente' }),
      entetes: { 'idempotency-key': cle },
    });
    expect(premiere.statusCode).toBe(201);
    expect(rejeu.json().id).toBe(premiere.json().id);
    expect(premiere.json()).toMatchObject({ statut: 'brouillon', nombrePeriodes: 7, tauxRecouvrement: null });
    const n = await b.owner.query(`SELECT count(*)::int AS n FROM echeances WHERE campagne_id = $1`, [
      premiere.json().id,
    ]);
    expect(n.rows[0].n).toBe(0);
  });

  it('parcours critique 4 : aperçu → activation → échéancier → paiement partiel → « partielle » ; avances imputées', async () => {
    const c = await creerCampagne();
    // RG-COT-022 : un membre a une avance de 5 000 avant l'activation.
    await payer(membres.avance!, [{ echeanceId: null, montant: 5000 }]);

    const apercu = await appeler(b, 'GET', `/v1/campagnes/${c.id}/apercu`, { jeton: jetonA });
    expect(apercu.statusCode).toBe(200);
    // Ciblés : actif, dormant, jeune, avance (pas l'honoraire, pas le suspendu).
    expect(apercu.json()).toMatchObject({
      membresCibles: 4,
      nombrePeriodes: 7,
      nombreEcheances: 28,
      montantTotal: 56_000,
    });
    expect(apercu.json().periodes[0]).toMatchObject({ numero: 1, dateEcheance: mois(-3, 10) });

    const act = await appeler(b, 'POST', `/v1/campagnes/${c.id}/activer`, { jeton: jetonTresorier });
    expect(act.statusCode, act.body).toBe(200);
    expect(act.json()).toMatchObject({ statut: 'active' });
    expect(
      (await appeler(b, 'POST', `/v1/campagnes/${c.id}/activer`, { jeton: jetonTresorier })).statusCode,
    ).toBe(409);
    const total = await b.owner.query(
      `SELECT count(*)::int AS n, count(DISTINCT membre_id)::int AS m FROM echeances WHERE campagne_id = $1`,
      [c.id],
    );
    expect(total.rows[0]).toEqual({ n: 28, m: 4 });

    // Avance : 2 000 + 2 000 + 1 000 sur les trois premières échéances, par date.
    const ea = await echeancesDe(c.id, membres.avance!);
    expect(ea.slice(0, 4).map((e) => [e.montantPaye, e.situation])).toEqual([
      [2000, 'payee'],
      [2000, 'payee'],
      [1000, 'en_retard'],
      [0, mois(0, 10) < aujourdhui() ? 'en_retard' : 'a_venir'],
    ]);
    const solde = await b.owner.query(
      `SELECT sum(montant)::int AS s FROM imputations_paiement WHERE membre_id = $1 AND echeance_id IS NULL`,
      [membres.avance],
    );
    expect(solde.rows[0].s).toBe(0);

    // Paiement partiel sur une échéance future → « partielle ».
    const ex = await echeancesDe(c.id, membres.actif!);
    const future = ex.find((e) => e.dateEcheance > aujourdhui())!;
    await payer(membres.actif!, [{ echeanceId: future.id, montant: 500 }]);
    const apres = (await echeancesDe(c.id, membres.actif!)).find((e) => e.id === future.id)!;
    expect(apres).toMatchObject({ montantPaye: 500, situation: 'partielle', imputee: true });

    // Statistiques (RG-RAP-002) et échéancier membres × périodes.
    const s = await appeler(b, 'GET', `/v1/campagnes/${c.id}/statistiques`, { jeton: jetonA });
    expect(s.statusCode).toBe(200);
    const echues = (
      await b.owner.query(
        `SELECT count(*)::int AS n FROM echeances WHERE campagne_id = $1 AND date_echeance <= current_date`,
        [c.id],
      )
    ).rows[0].n as number;
    expect(s.json()).toMatchObject({
      membresCibles: 4,
      montantAttendu: 56_000,
      montantEchuAttendu: echues * 2000,
      montantRecouvre: 5500,
    });
    expect(s.json().tauxRecouvrement).toBeCloseTo(5000 / (echues * 2000), 4);
    expect(s.json().parPeriode).toHaveLength(7);
    const grille = await appeler(b, 'GET', `/v1/campagnes/${c.id}/echeancier?limite=3`, { jeton: jetonA });
    expect(grille.json().donnees).toHaveLength(3);
    expect(grille.json().donnees[0].echeances).toHaveLength(7);
    const suite = await appeler(
      b,
      'GET',
      `/v1/campagnes/${c.id}/echeancier?limite=3&curseur=${grille.json().page.curseurSuivant}`,
      {
        jeton: jetonA,
      },
    );
    expect(suite.json().donnees).toHaveLength(1);
    expect(suite.json().page.curseurSuivant).toBeNull();
    const liste = await appeler(b, 'GET', `/v1/campagnes?statut=active`, { jeton: jetonA });
    expect(liste.json().donnees.find((x: { id: string }) => x.id === c.id).tauxRecouvrement).toBeCloseTo(
      s.json().tauxRecouvrement,
      4,
    );
  });

  it('RG-COT-010 : catégories ciblées ; RG-COT-012 : ajout après activation avec ou sans rattrapage', async () => {
    const c = await creerCampagne({ categoriesCibles: [catJeunes], libelle: 'Jeunes' });
    await appeler(b, 'POST', `/v1/campagnes/${c.id}/activer`, { jeton: jetonTresorier });
    const n = await b.owner.query(`SELECT DISTINCT membre_id FROM echeances WHERE campagne_id = $1`, [c.id]);
    expect(n.rows.map((r) => r.membre_id)).toEqual([membres.jeune]);

    const sans = await appeler(b, 'POST', `/v1/campagnes/${c.id}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [membres.honoraire] },
    });
    expect(sans.statusCode, sans.body).toBe(200);
    const futures = (await echeancesDe(c.id, membres.honoraire!)).map((e) => e.dateEcheance);
    expect(futures.length).toBeGreaterThan(0);
    expect(futures.every((d) => d >= aujourdhui())).toBe(true);
    expect(sans.json().echeancesCreees).toBe(futures.length);

    const avec = await appeler(b, 'POST', `/v1/campagnes/${c.id}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [membres.honoraire, membres.dormant], rattrapage: true },
    });
    // Honoraire : périodes passées manquantes ; dormant : les 7.
    expect(avec.json().echeancesCreees).toBe(7 - futures.length + 7);
    const inconnu = await appeler(b, 'POST', `/v1/campagnes/${c.id}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [randomUUID()] },
    });
    expect(inconnu.json().code).toBe('REFERENCE_INVALIDE');
  });

  it('RG-COT-013 : modifications après activation (If-Match, champs figés, prolongation, réduction, montant)', async () => {
    const c = await creerCampagne({ libelle: 'Modifiable' });
    // Brouillon : tout est modifiable.
    const brouillon = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { periodicite: 'trimestrielle', jourEcheance: 1 },
      entetes: { 'if-match': c.etag },
    });
    expect(brouillon.statusCode, brouillon.body).toBe(200);
    const perime = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { libelle: 'X' },
      entetes: { 'if-match': c.etag },
    });
    expect(perime.statusCode).toBe(412);
    await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { periodicite: 'mensuelle', jourEcheance: 10 },
    });
    await appeler(b, 'POST', `/v1/campagnes/${c.id}/activer`, { jeton: jetonTresorier });

    const fige = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { periodicite: 'annuelle' },
    });
    expect(fige.statusCode).toBe(422);
    expect(fige.json().erreurs[0]).toMatchObject({ champ: 'periodicite', code: 'NON_MODIFIABLE' });

    // Montant : seules les échéances futures, sans imputation ni ajustement individuel, sont réévaluées.
    const e0 = await echeancesDe(c.id, membres.actif!);
    const [f1, f2] = e0.filter((e) => e.dateEcheance > aujourdhui());
    await payer(membres.actif!, [{ echeanceId: f1!.id, montant: 100 }]);
    await appeler(b, 'PATCH', `/v1/echeances/${f2!.id}`, {
      jeton: jetonTresorier,
      corps: { montantDu: 1500 },
    });
    const m = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { montant: 2500 },
    });
    expect(m.statusCode, m.body).toBe(200);
    const e1 = await echeancesDe(c.id, membres.actif!);
    const du = (id: string) => e1.find((e) => e.id === id)!.montantDu;
    expect(du(f1!.id)).toBe(2000);
    expect(du(f2!.id)).toBe(1500);
    expect(e1.filter((e) => e.dateEcheance <= aujourdhui()).every((e) => e.montantDu === 2000)).toBe(true);
    expect(
      e1
        .filter((e) => e.dateEcheance > aujourdhui() && ![f1!.id, f2!.id].includes(e.id))
        .every((e) => e.montantDu === 2500),
    ).toBe(true);

    // Prolongation : 2 périodes de plus pour chaque membre de la campagne.
    const avant = (
      await b.owner.query(`SELECT count(*)::int AS n FROM echeances WHERE campagne_id = $1`, [c.id])
    ).rows[0].n;
    const p = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { dateFin: mois(5, 28) },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().nombrePeriodes).toBe(9);
    const apres = (
      await b.owner.query(`SELECT count(*)::int AS n FROM echeances WHERE campagne_id = $1`, [c.id])
    ).rows[0].n;
    expect(apres - avant).toBe(2 * 4);

    // Réduction : refusée si elle supprime une échéance déjà imputée ; acceptée sinon.
    const refus = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { dateFin: mois(0, 28) },
    });
    expect(refus.statusCode).toBe(422);
    expect(refus.json().code).toBe('ECHEANCE_DEJA_IMPUTEE');
    const ok = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { dateFin: mois(3, 28) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      (await b.owner.query(`SELECT count(*)::int AS n FROM echeances WHERE campagne_id = $1`, [c.id])).rows[0]
        .n,
    ).toBe(avant);
    const audit = await b.owner.query(
      `SELECT apres FROM audit_log WHERE entite_id = $1 AND action = 'campagne.modifiee' ORDER BY id`,
      [c.id],
    );
    expect(audit.rows.map((r) => r.apres)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ montant: 2500, echeancesReevaluees: expect.any(Number) }),
        expect.objectContaining({ echeancesCreees: 8 }),
        expect.objectContaining({ echeancesSupprimees: 8 }),
      ]),
    );
  });

  it('E4-04, RG-COT-014 : ajustement et exonération seulement sans imputation ; clôture (RG-COT-015)', async () => {
    const c = await creerCampagne({ libelle: 'Exonérations' });
    await appeler(b, 'POST', `/v1/campagnes/${c.id}/activer`, { jeton: jetonTresorier });
    const [e1, e2, e3] = await echeancesDe(c.id, membres.jeune!);
    await payer(membres.jeune!, [{ echeanceId: e1!.id, montant: 2000 }]);

    const imputee = await appeler(b, 'POST', `/v1/echeances/${e1!.id}/exonerer`, {
      jeton: jetonA,
      corps: { motif: 'Décès du conjoint' },
    });
    expect(imputee.statusCode).toBe(422);
    expect(imputee.json().code).toBe('ECHEANCE_DEJA_IMPUTEE');
    // Le trésorier n'a pas cotisation.exonerer.
    expect(
      (
        await appeler(b, 'POST', `/v1/echeances/${e2!.id}/exonerer`, {
          jeton: jetonTresorier,
          corps: { motif: 'Aide' },
        })
      ).statusCode,
    ).toBe(403);
    const ex = await appeler(b, 'POST', `/v1/echeances/${e2!.id}/exonerer`, {
      jeton: jetonA,
      corps: { motif: 'Décès du conjoint' },
    });
    expect(ex.statusCode, ex.body).toBe(200);
    expect(ex.json()).toMatchObject({
      situation: 'exoneree',
      montantDu: 0,
      motifExoneration: 'Décès du conjoint',
    });
    expect(
      (
        await appeler(b, 'POST', `/v1/echeances/${e2!.id}/exonerer`, {
          jeton: jetonA,
          corps: { motif: 'Encore' },
        })
      ).statusCode,
    ).toBe(409);

    const hors = await appeler(b, 'PATCH', `/v1/echeances/${e3!.id}`, {
      jeton: jetonTresorier,
      corps: { dateEcheance: mois(13) },
    });
    expect(hors.json().erreurs[0].code).toBe('HORS_EXERCICE');
    const aj = await appeler(b, 'PATCH', `/v1/echeances/${e3!.id}`, {
      jeton: jetonTresorier,
      corps: { montantDu: 1000, dateEcheance: mois(1, 15) },
    });
    expect(aj.statusCode, aj.body).toBe(200);
    expect(aj.json()).toMatchObject({ montantDu: 1000, dateEcheance: mois(1, 15) });
    expect(
      (
        await appeler(b, 'PATCH', `/v1/echeances/${e1!.id}`, {
          jeton: jetonTresorier,
          corps: { montantDu: 10 },
        })
      ).json().code,
    ).toBe('ECHEANCE_DEJA_IMPUTEE');

    const cl = await appeler(b, 'POST', `/v1/campagnes/${c.id}/cloturer`, { jeton: jetonTresorier });
    expect(cl.json().statut).toBe('cloturee');
    const ajout = await appeler(b, 'POST', `/v1/campagnes/${c.id}/membres`, {
      jeton: jetonTresorier,
      corps: { membreIds: [membres.honoraire] },
    });
    expect(ajout.statusCode).toBe(409);
    expect(
      (
        await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
          jeton: jetonTresorier,
          corps: { dateFin: mois(4) },
        })
      ).json().erreurs[0].code,
    ).toBe('NON_MODIFIABLE');
    const libelle = await appeler(b, 'PATCH', `/v1/campagnes/${c.id}`, {
      jeton: jetonTresorier,
      corps: { libelle: 'Exonérations (clôturée)' },
    });
    expect(libelle.statusCode).toBe(200);
    // Les échéances restantes restent dues : la situation du membre les compte.
    const restantes = await echeancesDe(c.id, membres.jeune!);
    expect(restantes).toHaveLength(7);
  });

  it('RG-EXE-002 : exercice clôturé → EXERCICE_FERME ; filtres et curseur des échéances ; isolation', async () => {
    const ex = await b.owner.query<{ id: string }>(
      `INSERT INTO exercices (association_id, libelle, date_debut, date_fin, statut, cloture_at)
       VALUES ($1, 'Ancien', '2000-01-01', '2000-12-31', 'cloture', now()) RETURNING id`,
      [A.associationId],
    );
    const ferme = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonTresorier,
      corps: corpsCampagne({ exerciceId: ex.rows[0]!.id, dateDebut: '2000-01-01', dateFin: '2000-06-30' }),
    });
    expect(ferme.statusCode).toBe(422);
    expect(ferme.json().code).toBe('EXERCICE_FERME');

    const p1 = await appeler(b, 'GET', `/v1/echeances?situation=en_retard&limite=5`, { jeton: jetonA });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().donnees.every((e: { situation: string }) => e.situation === 'en_retard')).toBe(true);
    const dates = p1.json().donnees.map((e: { dateEcheance: string }) => e.dateEcheance);
    expect([...dates].sort()).toEqual(dates);
    const p2 = await appeler(
      b,
      'GET',
      `/v1/echeances?situation=en_retard&limite=5&curseur=${p1.json().page.curseurSuivant}`,
      {
        jeton: jetonA,
      },
    );
    expect(p2.json().donnees[0].dateEcheance >= dates[dates.length - 1]).toBe(true);
    expect(p2.json().donnees.map((e: { id: string }) => e.id)).not.toContain(p1.json().donnees[0].id);

    const c = await creerCampagne({ libelle: 'Isolée' });
    expect((await appeler(b, 'GET', `/v1/campagnes/${c.id}`, { jeton: jetonB })).statusCode).toBe(404);
    expect((await appeler(b, 'POST', `/v1/campagnes/${c.id}/activer`, { jeton: jetonB })).statusCode).toBe(
      404,
    );
    expect((await appeler(b, 'GET', '/v1/campagnes', { jeton: jetonB })).json().donnees).toEqual([]);
    expect((await appeler(b, 'GET', '/v1/echeances', { jeton: jetonB })).json().donnees).toEqual([]);
  });
});

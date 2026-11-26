import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activerCompte,
  appeler,
  baseDisponible,
  connecterMobile,
  demarrer,
  telephoneFictif,
  type Banc,
} from './outils-integration.js';

/**
 * Autorisations, accès et rôles (E2-01, E2-02, E2-06, E2-07) et isolation multi-tenant (E2-08, base)
 * sur PostgreSQL via `app.inject`. Les présidents se connectent sur mobile (pas de TOTP sur mobile).
 */
describe.skipIf(!baseDisponible)('accès, rôles et autorisations (intégration PostgreSQL)', () => {
  let b: Banc;
  const telA = telephoneFictif();
  const telB = telephoneFictif();
  const telTresorier = telephoneFictif();
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let B: Awaited<ReturnType<Banc['associations']['creer']>>;
  let jetonA: string;
  let jetonB: string;
  let jetonTresorier: string;
  let refreshTresorier: string;
  let accesTresorierId: string;

  beforeAll(async () => {
    b = await demarrer();
    A = await b.associations.creer({
      nom: 'Association A Test-Accès',
      village: 'Kossou',
      region: 'Bélier',
      president: { telephone: telA, nom: 'Koffi', prenoms: 'Ama' },
    });
    B = await b.associations.creer({
      nom: 'Association B Test-Accès',
      village: 'Yamoussoukro',
      region: 'Bélier',
      president: { telephone: telB, nom: 'Bamba', prenoms: 'Ali' },
    });
    await activerCompte(b, telA);
    await activerCompte(b, telB);
    jetonA = (await connecterMobile(b, telA)).accessToken;
    jetonB = (await connecterMobile(b, telB)).accessToken;
  });
  afterAll(async () => b?.fermer());

  it('NON_AUTHENTIFIE sans jeton ou avec un jeton invalide', async () => {
    expect((await appeler(b, 'GET', '/v1/acces')).json().code).toBe('NON_AUTHENTIFIE');
    const r = await appeler(b, 'GET', '/v1/acces', { jeton: 'abc.def.ghi' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
  });

  it('E2-06 : le président invite un trésorier (compte créé, SMS envoyé, idempotent)', async () => {
    const corps = {
      telephone: telTresorier,
      nom: 'Traoré',
      prenoms: 'Mariam',
      roleId: A.roles.tresorier,
      mandatDebut: '2026-01-01',
    };
    const entetes = { 'idempotency-key': crypto.randomUUID() };
    const r = await appeler(b, 'POST', '/v1/acces', { jeton: jetonA, corps, entetes });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      user: {
        telephone: telTresorier,
        nom: 'Traoré',
        prenoms: 'Mariam',
        derniereConnexion: null,
        verrouille: false,
      },
      role: { id: A.roles.tresorier, code: 'tresorier', systeme: true },
      mandatDebut: '2026-01-01',
      mandatFin: null,
      membreId: null,
      statut: 'actif',
    });
    accesTresorierId = r.json().id;
    expect(b.sms.dernierMessage(telTresorier)).toBe(
      "Votre accès AssoFlow à Association A Test-Accès est prêt. Téléchargez l'app et connectez-vous avec ce numéro.",
    );
    const rejeu = await appeler(b, 'POST', '/v1/acces', { jeton: jetonA, corps, entetes });
    expect(rejeu.json().id).toBe(accesTresorierId);
    const conflit = await appeler(b, 'POST', '/v1/acces', {
      jeton: jetonA,
      corps: { ...corps, prenoms: 'Autre' },
      entetes,
    });
    expect(conflit.statusCode).toBe(409);
    expect(conflit.json().code).toBe('CONFLIT_IDEMPOTENCE');
    const doublon = await appeler(b, 'POST', '/v1/acces', { jeton: jetonA, corps });
    expect(doublon.statusCode).toBe(409);
  });

  it('invitation : rôle d’un autre tenant → 422 REFERENCE_INVALIDE', async () => {
    const r = await appeler(b, 'POST', '/v1/acces', {
      jeton: jetonA,
      corps: { telephone: telephoneFictif(), nom: 'X', prenoms: 'Y', roleId: B.roles.membre },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: 'REFERENCE_INVALIDE', erreurs: [{ champ: 'roleId' }] });
  });

  it('GET /v1/acces pagine par curseur', async () => {
    const p1 = await appeler(b, 'GET', '/v1/acces?limite=1', { jeton: jetonA });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().donnees).toHaveLength(1);
    expect(p1.json().donnees[0].role.code).toBe('president');
    const p2 = await appeler(b, 'GET', `/v1/acces?limite=1&curseur=${p1.json().page.curseurSuivant}`, {
      jeton: jetonA,
    });
    expect(p2.json().donnees.map((a: { id: string }) => a.id)).toEqual([accesTresorierId]);
    expect(p2.json().page.curseurSuivant).toBeNull();
    const filtre = await appeler(b, 'GET', `/v1/acces?roleId=${A.roles.tresorier}`, { jeton: jetonA });
    expect(filtre.json().donnees).toHaveLength(1);
  });

  it('E2-01 : permission manquante → 403 PERMISSION_REFUSEE', async () => {
    await activerCompte(b, telTresorier);
    const s = await connecterMobile(b, telTresorier);
    jetonTresorier = s.accessToken;
    refreshTresorier = s.refreshToken;
    expect((await appeler(b, 'GET', '/v1/roles', { jeton: jetonTresorier })).statusCode).toBe(200);
    const r = await appeler(b, 'POST', '/v1/roles', {
      jeton: jetonTresorier,
      corps: { code: 'adjoint', libelle: 'Adjoint', permissions: ['membre.lire'] },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('PERMISSION_REFUSEE');
    expect(
      (await appeler(b, 'POST', `/v1/acces/${accesTresorierId}/deverrouiller`, { jeton: jetonTresorier }))
        .statusCode,
    ).toBe(403);
  });

  it('E2-08 : la ressource d’un autre tenant est introuvable (404, jamais 403)', async () => {
    const cas: [string, string, unknown?][] = [
      ['PATCH', `/v1/acces/${accesTresorierId}`, { mandatFin: '2027-12-31' }],
      ['POST', `/v1/acces/${accesTresorierId}/revoquer`, { motif: 'Tentative croisée' }],
      ['POST', `/v1/acces/${accesTresorierId}/deverrouiller`],
      ['PATCH', `/v1/roles/${A.roles.tresorier}`, { libelle: 'Piraté' }],
      ['DELETE', `/v1/roles/${A.roles.tresorier}`],
      ['PATCH', '/v1/acces/pas-un-uuid', {}],
    ];
    for (const [methode, url, corps] of cas) {
      const r = await appeler(b, methode as 'PATCH', url, { jeton: jetonB, corps });
      expect(r.statusCode, `${methode} ${url}`).toBe(404);
      expect(r.json().code).toBe('INTROUVABLE');
    }
    const liste = await appeler(b, 'GET', '/v1/acces', { jeton: jetonB });
    expect(liste.json().donnees.map((a: { user: { telephone: string } }) => a.user.telephone)).toEqual([
      telB,
    ]);
    const roles = await appeler(b, 'GET', '/v1/roles', { jeton: jetonB });
    expect(roles.json().map((r: { id: string }) => r.id)).not.toContain(A.roles.tresorier);
    // Le jeton d'un tenant ne permet pas de choisir l'autre.
    const ctx = await appeler(b, 'POST', '/v1/auth/contexte', {
      jeton: jetonB,
      corps: { associationId: A.associationId },
    });
    expect(ctx.statusCode).toBe(403);
  });

  it('E2-06 : changement de rôle → permissions recalculées immédiatement (cache invalidé)', async () => {
    const r = await appeler(b, 'PATCH', `/v1/acces/${accesTresorierId}`, {
      jeton: jetonA,
      corps: { roleId: A.roles.secretaire, mandatFin: '2027-12-31' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      role: { code: 'secretaire' },
      mandatDebut: '2026-01-01',
      mandatFin: '2027-12-31',
    });
    // utilisateur.lire reste ; le trésorier n'a plus tresorerie.* : vérifié via /auth/moi.
    const moi = await appeler(b, 'GET', '/v1/auth/moi', { jeton: jetonTresorier });
    expect(moi.json().acces[0].role.code).toBe('secretaire');
    await appeler(b, 'PATCH', `/v1/acces/${accesTresorierId}`, {
      jeton: jetonA,
      corps: { roleId: A.roles.tresorier },
    });
  });

  it('garde-fou : le dernier président ne peut être ni rétrogradé ni révoqué (422 PRESIDENT_REQUIS)', async () => {
    const r = await appeler(b, 'PATCH', `/v1/acces/${A.presidentAccesId}`, {
      jeton: jetonA,
      corps: { roleId: A.roles.membre },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('PRESIDENT_REQUIS');
    const rv = await appeler(b, 'POST', `/v1/acces/${A.presidentAccesId}/revoquer`, {
      jeton: jetonA,
      corps: { motif: 'Test' },
    });
    expect(rv.json().code).toBe('PRESIDENT_REQUIS');
  });

  it('RF-005 : le président déverrouille un compte de son association', async () => {
    await b.owner.query(
      `UPDATE users SET verrouille_jusqua = now() + interval '15 minutes', echecs_connexion = 0 WHERE telephone = $1`,
      [telTresorier],
    );
    const liste = await appeler(b, 'GET', `/v1/acces?roleId=${A.roles.tresorier}`, { jeton: jetonA });
    expect(liste.json().donnees[0].user.verrouille).toBe(true);
    const r = await appeler(b, 'POST', `/v1/acces/${accesTresorierId}/deverrouiller`, { jeton: jetonA });
    expect(r.statusCode).toBe(204);
    const u = await b.owner.query(`SELECT verrouille_jusqua FROM users WHERE telephone = $1`, [telTresorier]);
    expect(u.rows[0].verrouille_jusqua).toBeNull();
  });

  it('RF-ADM-014 : un accès révoqué est refusé dès la requête suivante (403 ACCES_REVOQUE), sessions révoquées', async () => {
    // Permissions en cache avant la révocation.
    expect((await appeler(b, 'GET', '/v1/roles', { jeton: jetonTresorier })).statusCode).toBe(200);
    const r = await appeler(b, 'POST', `/v1/acces/${accesTresorierId}/revoquer`, {
      jeton: jetonA,
      corps: { motif: 'Fin de mandat anticipée' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().statut).toBe('revoque');
    const apres = await appeler(b, 'GET', '/v1/roles', { jeton: jetonTresorier });
    expect(apres.statusCode).toBe(403);
    expect(apres.json().code).toBe('ACCES_REVOQUE');
    const refresh = await appeler(b, 'POST', '/v1/auth/refresh', {
      corps: { refreshToken: refreshTresorier },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().code).toBe('SESSION_REVOQUEE');
    expect(
      (
        await appeler(b, 'POST', `/v1/acces/${accesTresorierId}/revoquer`, {
          jeton: jetonA,
          corps: { motif: 'Encore' },
        })
      ).statusCode,
    ).toBe(409);
    // Le président de B n'est pas touché.
    expect((await appeler(b, 'GET', '/v1/roles', { jeton: jetonB })).statusCode).toBe(200);
  });

  it('E2-07 : rôles personnalisés et garde-fous de la matrice', async () => {
    const reserve = await appeler(b, 'POST', '/v1/roles', {
      jeton: jetonA,
      corps: {
        code: 'tresorier_adjoint',
        libelle: 'Trésorier adjoint',
        permissions: ['paiement.enregistrer', 'role.gerer'],
      },
    });
    expect(reserve.statusCode).toBe(422);
    expect(reserve.json().erreurs[0]).toMatchObject({ champ: 'permissions.1', code: 'PERMISSION_RESERVEE' });
    const inconnue = await appeler(b, 'POST', '/v1/roles', {
      jeton: jetonA,
      corps: { code: 'x_role', libelle: 'X', permissions: ['inexistante.lire'] },
    });
    expect(inconnue.json().erreurs[0].code).toBe('PERMISSION_INCONNUE');

    const cree = await appeler(b, 'POST', '/v1/roles', {
      jeton: jetonA,
      corps: {
        code: 'tresorier_adjoint',
        libelle: 'Trésorier adjoint',
        permissions: ['paiement.enregistrer', 'cotisation.lire'],
      },
    });
    expect(cree.statusCode).toBe(201);
    expect(cree.json()).toMatchObject({
      systeme: false,
      permissions: ['cotisation.lire', 'paiement.enregistrer'],
    });
    const doublon = await appeler(b, 'POST', '/v1/roles', {
      jeton: jetonA,
      corps: { code: 'tresorier_adjoint', libelle: 'Bis', permissions: [] },
    });
    expect(doublon.json().erreurs[0].code).toBe('CODE_DEJA_UTILISE');

    const modifie = await appeler(b, 'PATCH', `/v1/roles/${cree.json().id}`, {
      jeton: jetonA,
      corps: { libelle: 'Trésorier adjoint (caisse)', permissions: ['paiement.enregistrer'] },
    });
    expect(modifie.statusCode).toBe(200);
    expect(modifie.json()).toMatchObject({
      libelle: 'Trésorier adjoint (caisse)',
      permissions: ['paiement.enregistrer'],
    });

    // Rôle système : on ajoute, on ne retire pas.
    const retrait = await appeler(b, 'PATCH', `/v1/roles/${A.roles.president}`, {
      jeton: jetonA,
      corps: { permissions: ['association.lire'] },
    });
    expect(retrait.statusCode).toBe(422);
    expect(retrait.json().erreurs[0].code).toBe('PERMISSION_SYSTEME_OBLIGATOIRE');
    const ajout = await appeler(b, 'GET', '/v1/roles', { jeton: jetonA });
    const membre = ajout.json().find((r: { code: string }) => r.code === 'membre');
    const enrichi = await appeler(b, 'PATCH', `/v1/roles/${membre.id}`, {
      jeton: jetonA,
      corps: { permissions: [...membre.permissions, 'document.lire'] },
    });
    expect(enrichi.statusCode).toBe(200);
    expect(
      (await appeler(b, 'PATCH', `/v1/roles/${membre.id}`, { jeton: jetonA, corps: { code: 'autre' } }))
        .statusCode,
    ).toBe(422);

    expect((await appeler(b, 'DELETE', `/v1/roles/${A.roles.tresorier}`, { jeton: jetonA })).statusCode).toBe(
      409,
    );
    expect((await appeler(b, 'DELETE', `/v1/roles/${cree.json().id}`, { jeton: jetonA })).statusCode).toBe(
      204,
    );
    expect((await appeler(b, 'DELETE', `/v1/roles/${cree.json().id}`, { jeton: jetonA })).statusCode).toBe(
      404,
    );
  });

  it('E2-01 : une délégation active ajoute la permission déléguée', async () => {
    // Le président délègue depense.valider au secrétaire de A (créé ici) ; table delegations, API au sprint 6.
    const tel = telephoneFictif();
    const inv = await appeler(b, 'POST', '/v1/acces', {
      jeton: jetonA,
      corps: { telephone: tel, nom: 'Coulibaly', prenoms: 'Awa', roleId: A.roles.secretaire },
    });
    await activerCompte(b, tel);
    const s = await connecterMobile(b, tel);
    const avant = await appeler(b, 'GET', '/v1/auth/moi', { jeton: s.accessToken });
    expect(avant.json().acces[0].permissions).not.toContain('depense.valider');
    await b.owner.query(
      `INSERT INTO delegations (association_id, delegant_id, delegataire_id, permission, debut, fin)
       VALUES ($1, $2, $3, 'depense.valider', now() - interval '1 hour', now() + interval '7 days')`,
      [A.associationId, A.presidentUserId, inv.json().user.id],
    );
    const apres = await appeler(b, 'GET', '/v1/auth/moi', { jeton: s.accessToken });
    expect(apres.json().acces[0].permissions).toContain('depense.valider');
  });

  it('GET /v1/permissions : catalogue', async () => {
    const r = await appeler(b, 'GET', '/v1/permissions', { jeton: jetonA });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toContainEqual({
      code: 'utilisateur.gerer',
      module: 'utilisateur',
      libelle: 'Gérer les accès (invitation, rôle, révocation)',
      reserveePresident: true,
    });
  });

  it('E2-02 : révocation, invitation et modifications sont tracées dans l’audit du tenant', async () => {
    const { rows } = await b.owner.query(
      `SELECT action, acteur_id, entite_id, avant, apres, request_id FROM audit_log WHERE association_id = $1 ORDER BY id`,
      [A.associationId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'association.creee',
        'acces.cree',
        'acces.modifie',
        'acces.revoque',
        'utilisateur.deverrouille',
        'role.cree',
        'role.modifie',
        'role.supprime',
      ]),
    );
    const revocation = rows.find((r) => r.action === 'acces.revoque')!;
    expect(revocation).toMatchObject({ acteur_id: A.presidentUserId, entite_id: accesTresorierId });
    expect(revocation.apres).toMatchObject({ statut: 'revoque', motif: 'Fin de mandat anticipée' });
    expect(revocation.request_id).toBeTruthy();
    // Téléphone masqué dans l'audit (docs/02 §6).
    expect(JSON.stringify(rows)).not.toContain(telTresorier);
    // Aucune trace de B dans la chaîne de A.
    expect(rows.every((r) => r.acteur_id !== B.presidentUserId)).toBe(true);
  });
});

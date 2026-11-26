import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionsService } from '../src/common/auth/permissions.service.js';
import {
  activerCompte,
  appeler,
  baseDisponible,
  connecterConsole,
  connecterMobile,
  demarrer,
  IMAGES,
  jetonPourRole,
  multipart,
  telephoneFictif,
  type Banc,
} from './outils-integration.js';

/**
 * Association, exercices et catégories (E2-03 à E2-05) : RG-ASS-003, RG-EXE-001 à 003, ETag/If-Match,
 * logo (magic bytes), permissions, isolation entre tenants et audit, sur PostgreSQL via `app.inject`.
 */
describe.skipIf(!baseDisponible)('association, exercices et catégories (intégration PostgreSQL)', () => {
  let b: Banc;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let B: Awaited<ReturnType<Banc['associations']['creer']>>;
  let jetonA: string;
  let jetonB: string;
  let jetonTresorier: string;
  let jetonConsoleA: string;

  beforeAll(async () => {
    b = await demarrer();
    const telA = telephoneFictif();
    const telB = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle A Test-Association',
      village: 'Kossou',
      region: 'Bélier',
      president: { telephone: telA, nom: 'Koffi', prenoms: 'Ama' },
    });
    B = await b.associations.creer({
      nom: 'Mutuelle B Test-Association',
      village: 'Bouaflé',
      region: 'Marahoué',
      president: { telephone: telB, nom: 'Bamba', prenoms: 'Ali' },
    });
    await activerCompte(b, telA);
    await activerCompte(b, telB);
    jetonA = (await connecterMobile(b, telA)).accessToken;
    jetonB = (await connecterMobile(b, telB)).accessToken;
    jetonTresorier = await jetonPourRole(b, jetonA, A.roles.tresorier);
    jetonConsoleA = await connecterConsole(b, telA);
  });
  afterAll(async () => b?.fermer());

  it('GET /association : profil du tenant actif avec ETag (en-tête = champ etag)', async () => {
    const r = await appeler(b, 'GET', '/v1/association', { jeton: jetonA });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      id: A.associationId,
      nom: 'Mutuelle A Test-Association',
      devise: 'XOF',
      seuilDoubleValidation: 100000,
      statut: 'active',
      logoUrl: null,
    });
    expect(r.headers.etag).toBe(r.json().etag);
    const rb = await appeler(b, 'GET', '/v1/association', { jeton: jetonB });
    expect(rb.json().id).toBe(B.associationId);
  });

  it('PATCH /association : If-Match périmé → 412 PRECONDITION_ECHOUEE ; à jour → 200 et nouvel ETag', async () => {
    const lu = await appeler(b, 'GET', '/v1/association', { jeton: jetonA });
    const etag = lu.headers.etag as string;
    const ok = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonA,
      corps: { sigle: 'MATA', telephone: '+2250700000001', devise: 'EUR' },
      entetes: { 'if-match': etag },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ sigle: 'MATA', telephone: '+2250700000001', devise: 'XOF' });
    expect(ok.headers.etag).not.toBe(etag);
    const perime = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonA,
      corps: { sigle: 'AUTRE' },
      entetes: { 'if-match': etag },
    });
    expect(perime.statusCode).toBe(412);
    expect(perime.json().code).toBe('PRECONDITION_ECHOUEE');
    // Une écriture ailleurs dans le tenant (membre, exercice…) ne change pas l'ETag du profil.
    await appeler(b, 'POST', '/v1/categories-membres', {
      jeton: jetonA,
      corps: { libelle: 'Sans effet ETag' },
    });
    const encore = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonA,
      corps: { sigle: 'MATA2' },
      entetes: { 'if-match': ok.headers.etag as string },
    });
    expect(encore.statusCode, encore.body).toBe(200);
    const audit = await b.owner.query(
      `SELECT avant, apres FROM audit_log WHERE association_id = $1 AND action = 'association.modifiee' ORDER BY id`,
      [A.associationId],
    );
    expect(audit.rows[0].apres).toEqual({ sigle: 'MATA', telephone: '+225 07 •• •• 00 01' });
    expect(audit.rows[0].avant).toEqual({ sigle: null, telephone: null });
  });

  it('PATCH /association : If-Match absent → 428 PRECONDITION_REQUISE depuis la console ; toléré depuis le mobile', async () => {
    const sans = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonConsoleA,
      corps: { sousPrefecture: 'Tiébissou' },
    });
    expect(sans.statusCode).toBe(428);
    expect(sans.json().code).toBe('PRECONDITION_REQUISE');
    const lu = await appeler(b, 'GET', '/v1/association', { jeton: jetonConsoleA });
    const avec = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonConsoleA,
      corps: { sousPrefecture: 'Tiébissou' },
      entetes: { 'if-match': lu.json().etag as string },
    });
    expect(avec.statusCode, avec.body).toBe(200);
    const mobile = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonA,
      corps: { sousPrefecture: 'Didiévi' },
    });
    expect(mobile.statusCode, mobile.body).toBe(200);
  });

  it('RG-ASS-003 : seuil de double validation modifiable par le président seulement, tracé', async () => {
    // Le rôle trésorier reçoit association.modifier (rôle système enrichi) : le seuil reste réservé au président.
    await b.owner.query(
      `UPDATE roles SET permissions = array_append(permissions, 'association.modifier') WHERE id = $1`,
      [A.roles.tresorier],
    );
    await b.app.get(PermissionsService).invalider(A.associationId);
    const refus = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonTresorier,
      corps: { seuilDoubleValidation: 50000 },
      entetes: { 'if-match': '*' },
    });
    expect(refus.statusCode).toBe(403);
    expect(refus.json().code).toBe('PERMISSION_REFUSEE');
    const autre = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonTresorier,
      corps: { seuilAlerteSolde: 20000 },
    });
    expect(autre.statusCode, autre.body).toBe(200);
    const ok = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonA,
      corps: { seuilDoubleValidation: 250000 },
    });
    expect(ok.json().seuilDoubleValidation).toBe(250000);
    const audit = await b.owner.query(
      `SELECT acteur_id, avant, apres FROM audit_log
        WHERE association_id = $1 AND action = 'association.modifiee' AND apres ? 'seuilDoubleValidation'`,
      [A.associationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      acteur_id: A.presidentUserId,
      avant: { seuilDoubleValidation: 100000 },
      apres: { seuilDoubleValidation: 250000 },
    });
    await b.owner.query(
      `UPDATE roles SET permissions = array_remove(permissions, 'association.modifier') WHERE id = $1`,
      [A.roles.tresorier],
    );
    await b.app.get(PermissionsService).invalider(A.associationId);
  });

  it('PATCH /association : validation (422) et permission (403)', async () => {
    const invalide = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonA,
      corps: { moisDebutExercice: 13, seuilDoubleValidation: 1.5 },
    });
    expect(invalide.statusCode).toBe(422);
    expect(
      invalide
        .json()
        .erreurs.map((e: { champ: string }) => e.champ)
        .sort(),
    ).toEqual(['moisDebutExercice', 'seuilDoubleValidation']);
    const refus = await appeler(b, 'PATCH', '/v1/association', {
      jeton: jetonTresorier,
      corps: { nom: 'X' },
    });
    expect(refus.statusCode).toBe(403);
  });

  it('PUT /association/logo : PNG accepté et servi par URL signée ; type usurpé ou trop gros → 422', async () => {
    const png = multipart(IMAGES.png, 'logo.png', 'image/png');
    const r = await appeler(b, 'PUT', '/v1/association/logo', {
      jeton: jetonA,
      corps: png.corps,
      entetes: png.entetes,
    });
    expect(r.statusCode, r.body).toBe(200);
    const url = new URL(r.json().logoUrl as string);
    const fichier = await b.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(fichier.statusCode).toBe(200);
    expect(fichier.headers['content-type']).toBe('image/png');
    expect(fichier.rawPayload.equals(IMAGES.png)).toBe(true);
    const falsifie = await b.app.inject({ method: 'GET', url: `${url.pathname}${url.search}x` });
    expect(falsifie.statusCode).toBe(404);

    const usurpe = multipart(Buffer.from('%PDF-1.7 pas une image'), 'logo.png', 'image/png');
    const refus = await appeler(b, 'PUT', '/v1/association/logo', {
      jeton: jetonA,
      corps: usurpe.corps,
      entetes: usurpe.entetes,
    });
    expect(refus.statusCode).toBe(422);
    expect(refus.json().erreurs[0]).toMatchObject({ champ: 'fichier', code: 'TYPE_FICHIER_INVALIDE' });

    const gros = multipart(
      Buffer.concat([IMAGES.png, Buffer.alloc(2 * 1024 * 1024)]),
      'gros.png',
      'image/png',
    );
    const trop = await appeler(b, 'PUT', '/v1/association/logo', {
      jeton: jetonA,
      corps: gros.corps,
      entetes: gros.entetes,
    });
    expect(trop.statusCode).toBe(422);
    expect(trop.json().erreurs[0].code).toBe('FICHIER_TROP_GROS');

    const json = await appeler(b, 'PUT', '/v1/association/logo', { jeton: jetonA, corps: { fichier: 'x' } });
    expect(json.statusCode).toBe(422);
    const interdit = await appeler(b, 'PUT', '/v1/association/logo', {
      jeton: jetonTresorier,
      corps: png.corps,
      entetes: png.entetes,
    });
    expect(interdit.statusCode).toBe(403);
  });

  it('RG-EXE-001 : chevauchement d’exercices refusé (422) ; exercice contigu accepté', async () => {
    const liste = await appeler(b, 'GET', '/v1/exercices', { jeton: jetonTresorier });
    expect(liste.statusCode).toBe(200);
    const courant = liste.json()[0];
    expect(courant).toMatchObject({ id: A.exerciceId, statut: 'ouvert', clotureAt: null });
    const chevauche = await appeler(b, 'POST', '/v1/exercices', {
      jeton: jetonA,
      corps: { libelle: 'Chevauchant', dateDebut: courant.dateFin, dateFin: '2099-12-31' },
    });
    expect(chevauche.statusCode).toBe(422);
    expect(chevauche.json().erreurs[0]).toMatchObject({ champ: 'dateDebut', code: 'CHEVAUCHEMENT' });
    const lendemain = new Date(`${courant.dateFin}T00:00:00Z`);
    lendemain.setUTCDate(lendemain.getUTCDate() + 1);
    const debut = lendemain.toISOString().slice(0, 10);
    const suivant = await appeler(b, 'POST', '/v1/exercices', {
      jeton: jetonTresorier,
      corps: {
        libelle: 'Exercice suivant',
        dateDebut: debut,
        dateFin: `${Number(debut.slice(0, 4)) + 1}${debut.slice(4)}`,
      },
    });
    expect(suivant.statusCode, suivant.body).toBe(201);
    const incoherent = await appeler(b, 'POST', '/v1/exercices', {
      jeton: jetonA,
      corps: { libelle: 'X', dateDebut: '2090-02-01', dateFin: '2090-01-01' },
    });
    expect(incoherent.statusCode).toBe(422);
    // Même la contrainte d'exclusion est respectée en cas de créations simultanées.
    const corps = { libelle: 'Concurrent', dateDebut: '2095-01-01', dateFin: '2095-12-31' };
    const paralleles = await Promise.all(
      [1, 2, 3].map(() => appeler(b, 'POST', '/v1/exercices', { jeton: jetonA, corps })),
    );
    expect(paralleles.map((r) => r.statusCode).sort()).toEqual([201, 422, 422]);
  });

  it('RG-EXE-003 : clôture refusée avec des dépenses en cours, puis acceptée ; seconde clôture → 409', async () => {
    const r = await b.owner.query<{ compte: string; categorie: string }>(
      `SELECT (SELECT id FROM comptes_tresorerie WHERE association_id = $1) AS compte,
              (SELECT id FROM categories_depense WHERE association_id = $1 LIMIT 1) AS categorie`,
      [A.associationId],
    );
    const depense = crypto.randomUUID();
    await b.owner.query(
      `INSERT INTO depenses (id, association_id, numero, libelle, montant, date_depense, categorie_id, beneficiaire,
                             compte_id, exercice_id, demandeur_id, statut)
       SELECT $1, $2, 'DEP-TEST-000001', 'Chaises', 45000, date_debut, $3, 'Menuiserie', $4, id, $5, 'validee'
         FROM exercices WHERE id = $6`,
      [depense, A.associationId, r.rows[0]!.categorie, r.rows[0]!.compte, A.presidentUserId, A.exerciceId],
    );
    const interdit = await appeler(b, 'POST', `/v1/exercices/${A.exerciceId}/cloturer`, {
      jeton: jetonTresorier,
    });
    expect(interdit.statusCode).toBe(403);
    const refus = await appeler(b, 'POST', `/v1/exercices/${A.exerciceId}/cloturer`, { jeton: jetonA });
    expect(refus.statusCode).toBe(422);
    expect(refus.json().code).toBe('DEPENSES_EN_COURS');
    expect(refus.json().detail).toContain('1 dépense');
    await b.owner.query(`UPDATE depenses SET statut = 'payee' WHERE id = $1`, [depense]);
    const ok = await appeler(b, 'POST', `/v1/exercices/${A.exerciceId}/cloturer`, { jeton: jetonA });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ statut: 'cloture' });
    expect(ok.json().clotureAt).toBeTruthy();
    const encore = await appeler(b, 'POST', `/v1/exercices/${A.exerciceId}/cloturer`, { jeton: jetonA });
    expect(encore.statusCode).toBe(409);
    const audit = await b.owner.query(
      `SELECT acteur_id FROM audit_log WHERE association_id = $1 AND action = 'exercice.cloture'`,
      [A.associationId],
    );
    expect(audit.rows).toEqual([{ acteur_id: A.presidentUserId }]);
  });

  it('E2-05 : catégories de membres et de dépenses (création, libellé unique, désactivation)', async () => {
    const liste = await appeler(b, 'GET', '/v1/categories-membres', { jeton: jetonTresorier });
    expect(liste.json().map((c: { libelle: string }) => c.libelle)).toContain('Membre ordinaire');
    const c = await appeler(b, 'POST', '/v1/categories-membres', {
      jeton: jetonA,
      corps: { libelle: 'Jeunesse', description: 'Moins de 25 ans' },
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json()).toMatchObject({ libelle: 'Jeunesse', description: 'Moins de 25 ans', actif: true });
    const doublon = await appeler(b, 'POST', '/v1/categories-membres', {
      jeton: jetonA,
      corps: { libelle: 'Jeunesse' },
    });
    expect(doublon.statusCode).toBe(422);
    expect(doublon.json().erreurs[0].code).toBe('DEJA_UTILISE');
    const maj = await appeler(b, 'PATCH', `/v1/categories-membres/${c.json().id}`, {
      jeton: jetonA,
      corps: { actif: false },
    });
    expect(maj.json()).toMatchObject({ libelle: 'Jeunesse', actif: false });

    const depenses = await appeler(b, 'GET', '/v1/categories-depense', { jeton: jetonTresorier });
    expect(depenses.json()).toHaveLength(4);
    const d = await appeler(b, 'POST', '/v1/categories-depense', {
      jeton: jetonA,
      corps: { nature: 'aide_sociale', libelle: 'Décès' },
    });
    expect(d.statusCode).toBe(201);
    const dm = await appeler(b, 'PATCH', `/v1/categories-depense/${d.json().id}`, {
      jeton: jetonA,
      corps: { libelle: 'Décès et funérailles' },
    });
    expect(dm.json()).toMatchObject({ nature: 'aide_sociale', libelle: 'Décès et funérailles', actif: true });
    expect(
      (
        await appeler(b, 'POST', '/v1/categories-depense', {
          jeton: jetonA,
          corps: { nature: 'inconnue', libelle: 'X' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await appeler(b, 'POST', '/v1/categories-membres', { jeton: jetonTresorier, corps: { libelle: 'Z' } }))
        .statusCode,
    ).toBe(403);
    const audit = await b.owner.query(
      `SELECT action FROM audit_log WHERE association_id = $1 AND entite_type IN ('categorie_membre', 'categorie_depense')
        ORDER BY id`,
      [A.associationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'categorie_membre.creee',
        'categorie_membre.modifiee',
        'categorie_depense.creee',
      ]),
    );
  });

  it('E2-08 : exercices et catégories d’un autre tenant introuvables (404)', async () => {
    const catA = (await appeler(b, 'GET', '/v1/categories-membres', { jeton: jetonA })).json()[0].id;
    const depA = (await appeler(b, 'GET', '/v1/categories-depense', { jeton: jetonA })).json()[0].id;
    const exB = (await appeler(b, 'GET', '/v1/exercices', { jeton: jetonB })).json();
    expect(exB.map((e: { id: string }) => e.id)).not.toContain(A.exerciceId);
    for (const [methode, url, corps] of [
      ['POST', `/v1/exercices/${A.exerciceId}/cloturer`, undefined],
      ['PATCH', `/v1/categories-membres/${catA}`, { libelle: 'Piratée' }],
      ['PATCH', `/v1/categories-depense/${depA}`, { libelle: 'Piratée' }],
      ['POST', '/v1/exercices/pas-un-uuid/cloturer', undefined],
    ] as const) {
      const r = await appeler(b, methode, url, { jeton: jetonB, corps });
      expect(r.statusCode, `${methode} ${url}`).toBe(404);
      expect(r.json().code).toBe('INTROUVABLE');
    }
    const cats = (await appeler(b, 'GET', '/v1/categories-membres', { jeton: jetonB })).json();
    expect(cats.map((c: { id: string }) => c.id)).not.toContain(catA);
  });
});

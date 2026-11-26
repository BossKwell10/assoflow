import { masquerTelephone, uuidv7 } from '@assoflow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DormanceService } from '../src/modules/membres/dormance.service.js';
import {
  activerCompte,
  appeler,
  baseDisponible,
  connecterMobile,
  demarrer,
  IMAGES,
  jetonPourRole,
  multipart,
  telephoneFictif,
  type Banc,
} from './outils-integration.js';

const CONSENTEMENT = { traitementDonnees: true, canal: 'console' } as const;

/**
 * Membres, familles, ayants droit (E3-01 à E3-07, E3-10, E3-11) : règles RG-MBR-001 à 006 et 009,
 * idempotence par id, ETag/If-Match, photo, permissions, isolation entre tenants et audit.
 */
describe.skipIf(!baseDisponible)('membres (intégration PostgreSQL)', () => {
  let b: Banc;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let B: Awaited<ReturnType<Banc['associations']['creer']>>;
  let jetonA: string;
  let jetonB: string;
  let jetonSecretaire: string;
  let jetonCommissaire: string;

  /** Crée un membre dans A (président) et renvoie la réponse. */
  async function creer(corps: Record<string, unknown>, jeton = jetonA) {
    return appeler(b, 'POST', '/v1/membres', {
      jeton,
      corps: { id: uuidv7(), consentement: CONSENTEMENT, ...corps },
    });
  }

  async function creerOk(corps: Record<string, unknown>, jeton = jetonA) {
    const r = await creer({ telephone: telephoneFictif(), ...corps }, jeton);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as Record<string, unknown> & { id: string; numero: string; etag: string };
  }

  beforeAll(async () => {
    b = await demarrer();
    const telA = telephoneFictif();
    const telB = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle A Test-Membres',
      village: 'Sakassou',
      region: 'Gbêkê',
      president: { telephone: telA, nom: 'Yao', prenoms: 'Akissi' },
    });
    B = await b.associations.creer({
      nom: 'Mutuelle B Test-Membres',
      village: 'Daloa',
      region: 'Haut-Sassandra',
      president: { telephone: telB, nom: 'Touré', prenoms: 'Issa' },
    });
    await activerCompte(b, telA);
    await activerCompte(b, telB);
    jetonA = (await connecterMobile(b, telA)).accessToken;
    jetonB = (await connecterMobile(b, telB)).accessToken;
    jetonSecretaire = await jetonPourRole(b, jetonA, A.roles.secretaire);
    jetonCommissaire = await jetonPourRole(b, jetonA, A.roles.commissaire);
  });
  afterAll(async () => b?.fermer());

  it('RG-MBR-001 : numéros MBR-NNNNNN sans trou sous 10 créations simultanées ; un échec ne consomme pas de numéro', async () => {
    const refus = await creer({ nom: 'Sans', prenoms: 'Contact' });
    expect(refus.statusCode).toBe(422);
    const reponses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        creer({ nom: 'Parallèle', prenoms: `N°${i}`, telephone: telephoneFictif() }),
      ),
    );
    expect(reponses.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    const numeros = reponses.map((r) => r.json().numero as string).sort();
    expect(numeros).toEqual(Array.from({ length: 10 }, (_, i) => `MBR-${String(i + 1).padStart(6, '0')}`));
    // Numérotation propre à chaque tenant.
    const rb = await creer({ nom: 'Premier', prenoms: 'De B', telephone: telephoneFictif() }, jetonB);
    expect(rb.json().numero).toBe('MBR-000001');
  });

  it('RF-020 : création complète, valeurs par défaut, consentement enregistré, audit avec téléphone masqué', async () => {
    const telephone = '+2250707070707';
    const m = await creerOk({
      nom: 'Kouassi',
      prenoms: 'Éléonore',
      telephone,
      sexe: 'F',
      dateNaissance: '1990-04-12',
      paysResidence: 'fr',
      villageOrigine: '',
      consentement: { traitementDonnees: true, canal: 'papier' },
    });
    expect(m).toMatchObject({
      nom: 'Kouassi',
      prenoms: 'Éléonore',
      telephone,
      paysResidence: 'FR',
      estDiaspora: true,
      villageOrigine: null,
      statutAdhesion: 'actif',
      etat: 'actif',
      canalPrefere: 'sms',
      telephoneWhatsapp: false,
      aAccesApp: false,
      soldeCotisations: 0,
      doublonProbable: false,
      doublonDe: null,
      anonymise: false,
      photoUrl: null,
    });
    expect(m.dateAdhesion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const consentements = await b.owner.query(
      `SELECT type, accorde, canal, recueilli_par FROM consentements WHERE membre_id = $1`,
      [m.id],
    );
    expect(consentements.rows).toEqual([
      { type: 'traitement_donnees', accorde: true, canal: 'papier', recueilli_par: A.presidentUserId },
    ]);
    const audit = await b.owner.query(
      `SELECT apres FROM audit_log WHERE association_id = $1 AND action = 'membre.cree' AND entite_id = $2`,
      [A.associationId, m.id],
    );
    expect(audit.rows[0].apres).toMatchObject({ numero: m.numero, telephone: '+225 07 •• •• 07 07' });
    const sansConsentement = await appeler(b, 'POST', '/v1/membres', {
      jeton: jetonA,
      corps: { id: uuidv7(), nom: 'X', prenoms: 'Y', telephone: telephoneFictif() },
    });
    expect(sansConsentement.statusCode).toBe(422);
    expect(sansConsentement.json().erreurs[0].champ).toBe('consentement');
    const pasV7 = await creer({
      id: crypto.randomUUID(),
      nom: 'X',
      prenoms: 'Y',
      telephone: telephoneFictif(),
    });
    expect(pasV7.statusCode).toBe(422);
  });

  it('idempotence : même id et même contenu → 200 avec la fiche ; contenu différent → 409 CONFLIT_IDEMPOTENCE', async () => {
    const corps = {
      id: uuidv7(),
      nom: 'Rejeu',
      prenoms: 'Hors ligne',
      telephone: telephoneFictif(),
      consentement: CONSENTEMENT,
    };
    const premier = await appeler(b, 'POST', '/v1/membres', { jeton: jetonA, corps });
    expect(premier.statusCode).toBe(201);
    const [rejeu, rejeuSimultane] = await Promise.all([
      appeler(b, 'POST', '/v1/membres', { jeton: jetonA, corps }),
      appeler(b, 'POST', '/v1/membres', { jeton: jetonSecretaire, corps }),
    ]);
    expect(rejeu.statusCode).toBe(200);
    expect(rejeuSimultane.statusCode).toBe(200);
    expect(rejeu.json()).toEqual(premier.json());
    const conflit = await appeler(b, 'POST', '/v1/membres', {
      jeton: jetonA,
      corps: { ...corps, prenoms: 'Autre contenu' },
    });
    expect(conflit.statusCode).toBe(409);
    expect(conflit.json().code).toBe('CONFLIT_IDEMPOTENCE');
    // Un id déjà pris dans un autre tenant : conflit, sans révéler la fiche.
    const autreTenant = await appeler(b, 'POST', '/v1/membres', { jeton: jetonB, corps });
    expect(autreTenant.statusCode).toBe(409);
    const compte = await b.owner.query(`SELECT count(*)::int AS n FROM membres WHERE id = $1`, [corps.id]);
    expect(compte.rows[0].n).toBe(1);
  });

  it('RG-MBR-002 : sans téléphone, il faut une famille dont le chef a un téléphone', async () => {
    const refus = await creer({ nom: 'Sans', prenoms: 'Téléphone' });
    expect(refus.statusCode).toBe(422);
    expect(refus.json().erreurs[0]).toMatchObject({ champ: 'telephone', code: 'CONTACT_REQUIS' });
    const chef = await creerOk({ nom: 'Konan', prenoms: 'Chef' });
    const famille = await appeler(b, 'POST', '/v1/familles', {
      jeton: jetonA,
      corps: { nom: 'Famille Konan', chefFamilleId: chef.id, villageOrigine: 'Sakassou' },
    });
    expect(famille.statusCode, famille.body).toBe(201);
    expect(famille.json()).toMatchObject({ nom: 'Famille Konan', chefFamilleId: chef.id, nombreMembres: 1 });
    const enfant = await creer({ nom: 'Konan', prenoms: 'Enfant', familleId: famille.json().id });
    expect(enfant.statusCode, enfant.body).toBe(201);
    expect(enfant.json()).toMatchObject({ telephone: null, familleId: famille.json().id });
    // Le chef ne peut plus retirer son téléphone : il est le seul contact de l'enfant.
    const retrait = await appeler(b, 'PATCH', `/v1/membres/${chef.id}`, {
      jeton: jetonA,
      corps: { telephone: null },
    });
    expect(retrait.statusCode).toBe(422);
    expect(retrait.json().erreurs[0].code).toBe('CONTACT_FAMILLE');
    const autreFamille = await appeler(b, 'POST', '/v1/familles', {
      jeton: jetonA,
      corps: { nom: 'Sans chef' },
    });
    const refusFamille = await creer({
      nom: 'Orphelin',
      prenoms: 'De contact',
      familleId: autreFamille.json().id,
    });
    expect(refusFamille.statusCode).toBe(422);
    const familleInconnue = await creer({ nom: 'X', prenoms: 'Y', familleId: crypto.randomUUID() });
    expect(familleInconnue.statusCode).toBe(422);
    expect(familleInconnue.json().code).toBe('REFERENCE_INVALIDE');
  });

  it('RG-MBR-006 : chef de famille membre de sa famille ; il ne la quitte pas sans successeur', async () => {
    const chef = await creerOk({ nom: 'Brou', prenoms: 'Chef' });
    const membre = await creerOk({ nom: 'Brou', prenoms: 'Cadet' });
    const etranger = await creerOk({ nom: 'Diallo', prenoms: 'Voisin' });
    const f = (
      await appeler(b, 'POST', '/v1/familles', {
        jeton: jetonA,
        corps: { id: uuidv7(), nom: 'Famille Brou', chefFamilleId: chef.id },
      })
    ).json();
    const rattache = await appeler(b, 'PATCH', `/v1/membres/${membre.id}`, {
      jeton: jetonA,
      corps: { familleId: f.id },
    });
    expect(rattache.statusCode, rattache.body).toBe(200);
    const horsFamille = await appeler(b, 'PATCH', `/v1/familles/${f.id}`, {
      jeton: jetonA,
      corps: { chefFamilleId: etranger.id },
    });
    expect(horsFamille.statusCode).toBe(422);
    expect(horsFamille.json().erreurs[0].code).toBe('CHEF_HORS_FAMILLE');
    const depart = await appeler(b, 'PATCH', `/v1/membres/${chef.id}`, {
      jeton: jetonA,
      corps: { familleId: null },
    });
    expect(depart.statusCode).toBe(422);
    expect(depart.json().erreurs[0].code).toBe('CHEF_DE_FAMILLE');
    const autreFamille = await appeler(b, 'POST', '/v1/familles', {
      jeton: jetonA,
      corps: { nom: 'Autre', chefFamilleId: membre.id },
    });
    expect(autreFamille.statusCode).toBe(422);
    expect(autreFamille.json().erreurs[0].code).toBe('AUTRE_FAMILLE');
    const succession = await appeler(b, 'PATCH', `/v1/familles/${f.id}`, {
      jeton: jetonA,
      corps: { chefFamilleId: membre.id, nom: 'Famille Brou-Kouadio' },
    });
    expect(succession.statusCode, succession.body).toBe(200);
    expect(succession.json()).toMatchObject({ chefFamilleId: membre.id, nombreMembres: 2 });
    const membres = await appeler(b, 'GET', `/v1/familles/${f.id}/membres`, { jeton: jetonCommissaire });
    expect(
      membres
        .json()
        .map((m: { id: string }) => m.id)
        .sort(),
    ).toEqual([chef.id, membre.id].sort());
    const liste = await appeler(b, 'GET', '/v1/familles?q=brou-kou&limite=1', { jeton: jetonA });
    expect(liste.json().donnees).toEqual([expect.objectContaining({ id: f.id })]);
    // Rejeu idempotent de la création de famille.
    const corps = { id: uuidv7(), nom: 'Famille Rejeu' };
    expect((await appeler(b, 'POST', '/v1/familles', { jeton: jetonA, corps })).statusCode).toBe(201);
    expect((await appeler(b, 'POST', '/v1/familles', { jeton: jetonA, corps })).statusCode).toBe(200);
    expect(
      (await appeler(b, 'POST', '/v1/familles', { jeton: jetonA, corps: { ...corps, nom: 'Autre' } }))
        .statusCode,
    ).toBe(409);
  });

  it('RG-MBR-003 : doublon probable → 422 CONFIRMATION_REQUISE (ref), confirmé → marqué, puis écarté', async () => {
    const telephone = telephoneFictif();
    const original = await creerOk({
      nom: 'Ouattara',
      prenoms: 'Mariam',
      telephone,
      dateNaissance: '1985-01-01',
    });
    const id = uuidv7();
    const avertissement = await creer({ id, nom: 'OUATTARA', prenoms: 'mariam', telephone });
    expect(avertissement.statusCode).toBe(422);
    expect(avertissement.json()).toMatchObject({
      code: 'CONFIRMATION_REQUISE',
      erreurs: [{ champ: 'confirmationDoublon', code: 'DOUBLON_PROBABLE', ref: original.id }],
    });
    const confirme = await creer({
      id,
      nom: 'OUATTARA',
      prenoms: 'mariam',
      telephone,
      confirmationDoublon: true,
    });
    expect(confirme.statusCode, confirme.body).toBe(201);
    expect(confirme.json()).toMatchObject({ doublonProbable: true, doublonDe: original.id });
    // Second critère : même téléphone + même date de naissance, autre nom.
    const parDate = await creer({ nom: 'Autre', prenoms: 'Nom', telephone, dateNaissance: '1985-01-01' });
    expect(parDate.json().code).toBe('CONFIRMATION_REQUISE');
    // Modification d'une fiche qui devient un doublon : signalement non bloquant.
    const autre = await creerOk({ nom: 'Ouattara', prenoms: 'Mariam' });
    const modif = await appeler(b, 'PATCH', `/v1/membres/${autre.id}`, {
      jeton: jetonA,
      corps: { telephone },
    });
    expect(modif.json()).toMatchObject({ doublonProbable: true, doublonDe: original.id });

    const doublons = await appeler(b, 'GET', '/v1/membres/doublons', { jeton: jetonCommissaire });
    expect(doublons.json().map((m: { id: string }) => m.id)).toEqual([id, autre.id]);
    const ecarte = await appeler(b, 'POST', `/v1/membres/${id}/doublon`, {
      jeton: jetonA,
      corps: { decision: 'pas_doublon' },
    });
    expect(ecarte.json()).toMatchObject({ doublonProbable: false, doublonDe: null });
    expect(
      (
        await appeler(b, 'POST', `/v1/membres/${id}/doublon`, {
          jeton: jetonA,
          corps: { decision: 'pas_doublon' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await appeler(b, 'POST', `/v1/membres/${autre.id}/doublon`, {
          jeton: jetonA,
          corps: { decision: 'fusion' },
        })
      ).statusCode,
    ).toBe(422);
    const restants = await appeler(b, 'GET', '/v1/membres/doublons', { jeton: jetonA });
    expect(restants.json().map((m: { id: string }) => m.id)).toEqual([autre.id]);
  });

  it('ETag/If-Match : 412 si la fiche a changé, audit des seuls champs modifiés', async () => {
    const m = await creerOk({ nom: 'Coulibaly', prenoms: 'Awa' });
    const lu = await appeler(b, 'GET', `/v1/membres/${m.id}`, { jeton: jetonA });
    expect(lu.headers.etag).toBe(m.etag);
    const ok = await appeler(b, 'PATCH', `/v1/membres/${m.id}`, {
      jeton: jetonSecretaire,
      corps: { lieuResidence: 'Abidjan', telephone: '+2250102030405', nom: 'Coulibaly' },
      entetes: { 'if-match': m.etag },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers.etag).not.toBe(m.etag);
    expect(ok.json().etag).toBe(ok.headers.etag);
    const perime = await appeler(b, 'PATCH', `/v1/membres/${m.id}`, {
      jeton: jetonA,
      corps: { notes: 'trop tard' },
      entetes: { 'if-match': m.etag },
    });
    expect(perime.statusCode).toBe(412);
    expect(perime.json().code).toBe('PRECONDITION_ECHOUEE');
    const faible = await appeler(b, 'PATCH', `/v1/membres/${m.id}`, {
      jeton: jetonA,
      corps: { notes: 'à jour' },
      entetes: { 'if-match': `W/${ok.headers.etag as string}` },
    });
    expect(faible.statusCode).toBe(200);
    const audit = await b.owner.query(
      `SELECT avant, apres FROM audit_log WHERE association_id = $1 AND action = 'membre.modifie' AND entite_id = $2
        ORDER BY id`,
      [A.associationId, m.id],
    );
    expect(audit.rows[0]).toEqual({
      avant: { lieuResidence: null, telephone: masquerTelephone(m.telephone as string) },
      apres: { lieuResidence: 'Abidjan', telephone: '+225 01 •• •• 04 05' },
    });
  });

  it('RG-MBR-004 : suspendre, désactiver (masqué des listes), réactiver ; transitions impossibles → 409', async () => {
    const m = await creerOk({ nom: 'Zadi', prenoms: 'Transition' });
    const susp = await appeler(b, 'POST', `/v1/membres/${m.id}/suspendre`, {
      jeton: jetonSecretaire,
      corps: { motif: 'Absences répétées' },
    });
    expect(susp.json()).toMatchObject({ etat: 'suspendu', motifEtat: 'Absences répétées' });
    expect(
      (
        await appeler(b, 'POST', `/v1/membres/${m.id}/suspendre`, {
          jeton: jetonA,
          corps: { motif: 'Encore' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await appeler(b, 'POST', `/v1/membres/${m.id}/suspendre`, { jeton: jetonA, corps: {} })).statusCode,
    ).toBe(422);
    const des = await appeler(b, 'POST', `/v1/membres/${m.id}/desactiver`, {
      jeton: jetonA,
      corps: { motif: 'Départ du village' },
    });
    expect(des.json().etat).toBe('desactive');
    const defaut = await appeler(b, 'GET', '/v1/membres?q=Zadi', { jeton: jetonA });
    expect(defaut.json().donnees).toHaveLength(0);
    const filtre = await appeler(b, 'GET', '/v1/membres?q=Zadi&etat=desactive', { jeton: jetonA });
    expect(filtre.json().donnees.map((x: { id: string }) => x.id)).toEqual([m.id]);
    const re = await appeler(b, 'POST', `/v1/membres/${m.id}/reactiver`, { jeton: jetonA });
    expect(re.json()).toMatchObject({ etat: 'actif', motifEtat: null });
    expect((await appeler(b, 'POST', `/v1/membres/${m.id}/reactiver`, { jeton: jetonA })).statusCode).toBe(
      409,
    );
    expect(
      (
        await appeler(b, 'POST', `/v1/membres/${m.id}/suspendre`, {
          jeton: jetonCommissaire,
          corps: { motif: 'xxx' },
        })
      ).statusCode,
    ).toBe(403);
    const actions = await b.owner.query(
      `SELECT action, apres FROM audit_log WHERE entite_id = $1 AND action <> 'membre.cree' ORDER BY id`,
      [m.id],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      'membre.suspendu',
      'membre.desactive',
      'membre.reactive',
    ]);
  });

  it('RF-025 : recherche (nom, prénoms, numéro, téléphone), filtres, tris et pagination par curseur', async () => {
    const cat = (
      await appeler(b, 'POST', '/v1/categories-membres', {
        jeton: jetonA,
        corps: { libelle: 'Diaspora Europe' },
      })
    ).json();
    const a = await creerOk({
      nom: 'Gbagbo',
      prenoms: 'Ésaïe',
      telephone: '+2250545454545',
      categorieId: cat.id,
      paysResidence: 'FR',
    });
    const c = await creerOk({ nom: 'Gbagbo', prenoms: 'Adjoua', categorieId: cat.id });
    for (const q of ['gbagbo esaie', 'Esaïe GBAGBO', a.numero, '0545454545', '45454545']) {
      const r = await appeler(b, 'GET', `/v1/membres?q=${encodeURIComponent(q)}`, { jeton: jetonA });
      expect(
        r.json().donnees.map((m: { id: string }) => m.id),
        q,
      ).toEqual([a.id]);
    }
    const parCategorie = await appeler(b, 'GET', `/v1/membres?categorieId=${cat.id}&tri=-nom&total=true`, {
      jeton: jetonA,
    });
    expect(parCategorie.json().donnees.map((m: { id: string }) => m.id)).toEqual([a.id, c.id]);
    expect(parCategorie.json().page.total).toBe(2);
    const diaspora = await appeler(b, 'GET', `/v1/membres?categorieId=${cat.id}&diaspora=true`, {
      jeton: jetonA,
    });
    expect(diaspora.json().donnees.map((m: { id: string }) => m.id)).toEqual([a.id]);
    expect((await appeler(b, 'GET', '/v1/membres?tri=prenoms', { jeton: jetonA })).statusCode).toBe(422);
    expect((await appeler(b, 'GET', '/v1/membres?diaspora=oui', { jeton: jetonA })).statusCode).toBe(422);
    const enRetard = await appeler(
      b,
      'GET',
      `/v1/membres?categorieId=${cat.id}&enRetard=false&tri=soldeCotisations`,
      {
        jeton: jetonA,
      },
    );
    expect(enRetard.json().donnees).toHaveLength(2);

    for (const tri of ['nom', '-nom', 'numero', '-dateAdhesion', 'soldeCotisations']) {
      const tous: string[] = [];
      let curseur: string | null = null;
      do {
        const r = await appeler(
          b,
          'GET',
          `/v1/membres?limite=7&tri=${tri}${curseur ? `&curseur=${curseur}` : ''}`,
          { jeton: jetonA },
        );
        expect(r.statusCode, r.body).toBe(200);
        tous.push(...r.json().donnees.map((m: { id: string }) => m.id));
        curseur = r.json().page.curseurSuivant;
      } while (curseur);
      const total = (await appeler(b, 'GET', '/v1/membres?limite=1&total=true', { jeton: jetonA })).json()
        .page.total;
      expect(tous, tri).toHaveLength(total);
      expect(new Set(tous).size).toBe(total);
    }
    const numeros = (await appeler(b, 'GET', '/v1/membres?tri=numero&limite=200', { jeton: jetonA }))
      .json()
      .donnees.map((m: { numero: string }) => m.numero);
    expect(numeros).toEqual([...numeros].sort());
    const curseurNom = (await appeler(b, 'GET', '/v1/membres?limite=1', { jeton: jetonA })).json().page
      .curseurSuivant;
    expect(
      (await appeler(b, 'GET', `/v1/membres?tri=numero&curseur=${curseurNom}`, { jeton: jetonA })).statusCode,
    ).toBe(422);
  });

  it('RF-035 et RF-026 : situation depuis les vues, historique chronologique', async () => {
    const m = await creerOk({ nom: 'Situation', prenoms: 'Test', dateAdhesion: '2020-01-01' });
    const campagne = await b.owner.query<{ id: string }>(
      `INSERT INTO campagnes_cotisation (association_id, exercice_id, libelle, montant, periodicite, date_debut, date_fin, statut)
       VALUES ($1, $2, 'Cotisation test', 5000, 'mensuelle', '2020-01-01', '2099-12-31', 'active') RETURNING id`,
      [A.associationId, A.exerciceId],
    );
    await b.owner.query(
      `INSERT INTO echeances (association_id, campagne_id, membre_id, numero_periode, libelle_periode, montant_du, date_echeance)
       VALUES ($1, $2, $3, 1, 'Janvier 2020', 5000, '2020-01-05'), ($1, $2, $3, 2, 'Février 2020', 3000, '2020-02-05'),
              ($1, $2, $3, 3, 'Décembre 2099', 7000, '2099-12-05')`,
      [A.associationId, campagne.rows[0]!.id, m.id],
    );
    const s = await appeler(b, 'GET', `/v1/membres/${m.id}/situation`, { jeton: jetonCommissaire });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({
      membreId: m.id,
      totalExigible: 8000,
      totalPaye: 0,
      resteDu: 8000,
      avance: 0,
      echeancesEnRetard: 2,
      prochaineEcheance: {
        libellePeriode: 'Décembre 2099',
        montantDu: 7000,
        situation: 'a_venir',
        campagneLibelle: 'Cotisation test',
        membreNumero: m.numero,
      },
    });
    const fiche = await appeler(b, 'GET', `/v1/membres/${m.id}`, { jeton: jetonA });
    expect(fiche.json().soldeCotisations).toBe(-8000);
    const retard = await appeler(b, 'GET', '/v1/membres?enRetard=true', { jeton: jetonA });
    expect(retard.json().donnees.map((x: { id: string }) => x.id)).toEqual([m.id]);

    await appeler(b, 'PATCH', `/v1/membres/${m.id}`, { jeton: jetonA, corps: { notes: 'Note' } });
    await appeler(b, 'POST', `/v1/membres/${m.id}/suspendre`, { jeton: jetonA, corps: { motif: 'Retards' } });
    await appeler(b, 'POST', `/v1/membres/${m.id}/ayants-droit`, {
      jeton: jetonA,
      corps: { nom: 'Situation', prenoms: 'Fils', lien: 'enfant' },
    });
    const h1 = await appeler(b, 'GET', `/v1/membres/${m.id}/historique?limite=2`, { jeton: jetonA });
    expect(h1.statusCode, h1.body).toBe(200);
    const h2 = await appeler(
      b,
      'GET',
      `/v1/membres/${m.id}/historique?limite=2&curseur=${h1.json().page.curseurSuivant}`,
      {
        jeton: jetonA,
      },
    );
    const evenements = [...h1.json().donnees, ...h2.json().donnees];
    expect(evenements.map((e: { type: string; libelle: string }) => [e.type, e.libelle])).toEqual([
      ['modification', 'Ayant droit ajouté'],
      ['statut', 'Suspendu : Retards'],
      ['modification', 'Fiche modifiée : notes'],
      ['creation', `Fiche créée (${m.numero})`],
    ]);
    expect(h2.json().page.curseurSuivant).toBeNull();
  });

  it('E3-06 : ayants droit (ajout idempotent, modification, retrait logique)', async () => {
    const m = await creerOk({ nom: 'Famille', prenoms: 'Ayants' });
    const id = uuidv7();
    const corps = { id, nom: 'Ayants', prenoms: 'Conjointe', lien: 'conjoint', dateNaissance: '1992-05-01' };
    const cree = await appeler(b, 'POST', `/v1/membres/${m.id}/ayants-droit`, { jeton: jetonA, corps });
    expect(cree.statusCode, cree.body).toBe(201);
    expect(
      (await appeler(b, 'POST', `/v1/membres/${m.id}/ayants-droit`, { jeton: jetonA, corps })).statusCode,
    ).toBe(200);
    const maj = await appeler(b, 'PATCH', `/v1/membres/${m.id}/ayants-droit/${id}`, {
      jeton: jetonSecretaire,
      corps: { prenoms: 'Épouse' },
    });
    expect(maj.json()).toEqual({
      id,
      nom: 'Ayants',
      prenoms: 'Épouse',
      lien: 'conjoint',
      dateNaissance: '1992-05-01',
    });
    expect(
      (await appeler(b, 'GET', `/v1/membres/${m.id}/ayants-droit`, { jeton: jetonCommissaire })).json(),
    ).toHaveLength(1);
    expect(
      (
        await appeler(b, 'POST', `/v1/membres/${m.id}/ayants-droit`, {
          jeton: jetonA,
          corps: { nom: 'X', prenoms: 'Y', lien: 'cousin' },
        })
      ).statusCode,
    ).toBe(422);
    const autre = await creerOk({ nom: 'Autre', prenoms: 'Membre' });
    expect(
      (
        await appeler(b, 'PATCH', `/v1/membres/${autre.id}/ayants-droit/${id}`, {
          jeton: jetonA,
          corps: { nom: 'Z' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await appeler(b, 'DELETE', `/v1/membres/${m.id}/ayants-droit/${id}`, { jeton: jetonA })).statusCode,
    ).toBe(204);
    expect(
      (await appeler(b, 'GET', `/v1/membres/${m.id}/ayants-droit`, { jeton: jetonA })).json(),
    ).toHaveLength(0);
    expect(
      (await appeler(b, 'DELETE', `/v1/membres/${m.id}/ayants-droit/${id}`, { jeton: jetonA })).statusCode,
    ).toBe(404);
  });

  it('RF-020 : photo JPEG/WebP acceptée, type usurpé refusé (422)', async () => {
    const m = await creerOk({ nom: 'Photo', prenoms: 'Membre' });
    const jpeg = multipart(IMAGES.jpeg, 'photo.jpg', 'image/jpeg');
    const r = await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
      jeton: jetonSecretaire,
      corps: jpeg.corps,
      entetes: jpeg.entetes,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().photoUrl).toContain('/v1/fichiers?c=');
    const webp = multipart(IMAGES.webp, 'photo.webp', 'image/webp');
    const r2 = await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
      jeton: jetonA,
      corps: webp.corps,
      entetes: webp.entetes,
    });
    expect(r2.statusCode).toBe(200);
    const url = new URL(r2.json().photoUrl as string);
    expect(
      (await b.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })).headers['content-type'],
    ).toBe('image/webp');
    // L'ancienne photo a été supprimée du stockage.
    const ancienne = new URL(r.json().photoUrl as string);
    expect(
      (await b.app.inject({ method: 'GET', url: `${ancienne.pathname}${ancienne.search}` })).statusCode,
    ).toBe(404);
    const html = multipart(Buffer.from('<html><script>alert(1)</script></html>'), 'photo.jpg', 'image/jpeg');
    const refus = await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
      jeton: jetonA,
      corps: html.corps,
      entetes: html.entetes,
    });
    expect(refus.statusCode).toBe(422);
    expect(refus.json().erreurs[0].code).toBe('TYPE_FICHIER_INVALIDE');
    const mauvaisChamp = multipart(IMAGES.png, 'photo.png', 'image/png', 'image');
    expect(
      (
        await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
          jeton: jetonA,
          corps: mauvaisChamp.corps,
          entetes: mauvaisChamp.entetes,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
          jeton: jetonCommissaire,
          corps: jpeg.corps,
          entetes: jpeg.entetes,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('accès app : invitation avec le rôle membre, liée à la fiche', async () => {
    const m = await creerOk({ nom: 'Appli', prenoms: 'Mobile' });
    const r = await appeler(b, 'POST', `/v1/membres/${m.id}/acces-app`, { jeton: jetonA });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ membreId: m.id, role: { code: 'membre' }, statut: 'actif' });
    expect(b.sms.dernierMessage(m.telephone as string)).toContain(
      'Votre accès AssoFlow à Mutuelle A Test-Membres',
    );
    const fiche = await appeler(b, 'GET', `/v1/membres/${m.id}`, { jeton: jetonA });
    expect(fiche.json().aAccesApp).toBe(true);
    expect((await appeler(b, 'POST', `/v1/membres/${m.id}/acces-app`, { jeton: jetonA })).statusCode).toBe(
      409,
    );
    expect(
      (await appeler(b, 'POST', `/v1/membres/${m.id}/acces-app`, { jeton: jetonSecretaire })).statusCode,
    ).toBe(403);
    // Anonymisation refusée tant que l'accès est actif.
    const anon = await appeler(b, 'POST', `/v1/membres/${m.id}/anonymiser`, {
      jeton: jetonA,
      corps: { motif: 'Demande' },
    });
    expect(anon.statusCode).toBe(409);
  });

  it('RG-MBR-009 : anonymisation irréversible — données effacées, numéro conservé, audit sans donnée personnelle', async () => {
    const m = await creerOk({
      nom: 'Effacé',
      prenoms: 'Bientôt',
      email: 'efface@example.ci',
      dateNaissance: '1970-07-07',
      notes: 'Notes personnelles',
      villageOrigine: 'Tiébissou',
    });
    const jpeg = multipart(IMAGES.jpeg, 'p.jpg', 'image/jpeg');
    const photo = await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
      jeton: jetonA,
      corps: jpeg.corps,
      entetes: jpeg.entetes,
    });
    await appeler(b, 'POST', `/v1/membres/${m.id}/ayants-droit`, {
      jeton: jetonA,
      corps: { nom: 'Effacé', prenoms: 'Enfant', lien: 'enfant' },
    });
    const f = await appeler(b, 'POST', '/v1/familles', {
      jeton: jetonA,
      corps: { nom: 'Famille Effacé', chefFamilleId: m.id },
    });
    expect(
      (
        await appeler(b, 'POST', `/v1/membres/${m.id}/anonymiser`, {
          jeton: jetonSecretaire,
          corps: { motif: 'RGPD' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await appeler(b, 'POST', `/v1/membres/${m.id}/anonymiser`, { jeton: jetonA, corps: {} })).statusCode,
    ).toBe(422);
    const r = await appeler(b, 'POST', `/v1/membres/${m.id}/anonymiser`, {
      jeton: jetonA,
      corps: { motif: 'Demande écrite du membre' },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      numero: m.numero,
      nom: 'Anonyme',
      prenoms: '',
      telephone: null,
      email: null,
      dateNaissance: null,
      villageOrigine: null,
      notes: null,
      photoUrl: null,
      familleId: null,
      etat: 'desactive',
      anonymise: true,
    });
    const ancienne = new URL(photo.json().photoUrl as string);
    expect(
      (await b.app.inject({ method: 'GET', url: `${ancienne.pathname}${ancienne.search}` })).statusCode,
    ).toBe(404);
    const ligne = await b.owner.query(
      `SELECT nom, telephone, email, photo_cle, empreinte_creation, anonymise_at FROM membres WHERE id = $1`,
      [m.id],
    );
    expect(ligne.rows[0]).toMatchObject({
      nom: 'Anonyme',
      telephone: null,
      email: null,
      photo_cle: null,
      empreinte_creation: null,
    });
    const ayants = await b.owner.query(
      `SELECT nom, prenoms, deleted_at FROM ayants_droit WHERE membre_id = $1`,
      [m.id],
    );
    expect(ayants.rows[0]).toMatchObject({ nom: 'Anonyme', prenoms: '' });
    expect(ayants.rows[0].deleted_at).not.toBeNull();
    const famille = await b.owner.query(`SELECT chef_famille_id FROM familles WHERE id = $1`, [f.json().id]);
    expect(famille.rows[0].chef_famille_id).toBeNull();
    const audit = await b.owner.query(
      `SELECT acteur_id, avant, apres FROM audit_log WHERE action = 'membre.anonymise' AND entite_id = $1`,
      [m.id],
    );
    expect(audit.rows[0]).toMatchObject({
      acteur_id: A.presidentUserId,
      apres: { numero: m.numero, motif: 'Demande écrite du membre', ayantsDroitEffaces: 1 },
    });
    expect(JSON.stringify(audit.rows[0].apres)).not.toContain('Effacé');
    // Irréversible : plus aucune modification ni transition.
    for (const [methode, url, corps] of [
      ['PATCH', `/v1/membres/${m.id}`, { nom: 'Retour' }],
      ['POST', `/v1/membres/${m.id}/reactiver`, undefined],
      ['POST', `/v1/membres/${m.id}/anonymiser`, { motif: 'Encore' }],
      ['POST', `/v1/membres/${m.id}/ayants-droit`, { nom: 'X', prenoms: 'Y', lien: 'autre' }],
    ] as const) {
      const x = await appeler(b, methode, url, { jeton: jetonA, corps });
      expect(x.statusCode, `${methode} ${url}`).toBe(409);
    }
    const h = await appeler(b, 'GET', `/v1/membres/${m.id}/historique`, { jeton: jetonA });
    expect(h.json().donnees[0]).toMatchObject({ type: 'statut', libelle: 'Fiche anonymisée' });
    expect(JSON.stringify(h.json())).not.toContain('Effacé');
  });

  it('RG-MBR-005 : passage en dormance (retard et aucun paiement depuis jours_retard_dormant)', async () => {
    const ancien = await creerOk({ nom: 'Dormant', prenoms: 'Ancien', dateAdhesion: '2019-01-01' });
    const recent = await creerOk({ nom: 'Dormant', prenoms: 'Récent' });
    const honoraire = await creerOk({
      nom: 'Dormant',
      prenoms: 'Honoraire',
      dateAdhesion: '2019-01-01',
      statutAdhesion: 'honoraire',
    });
    const aJour = await creerOk({ nom: 'Dormant', prenoms: 'À jour', dateAdhesion: '2019-01-01' });
    const campagne = await b.owner.query<{ id: string }>(
      `INSERT INTO campagnes_cotisation (association_id, exercice_id, libelle, montant, periodicite, date_debut, date_fin, statut)
       VALUES ($1, $2, 'Dormance', 1000, 'unique', '2020-01-01', '2020-01-01', 'active') RETURNING id`,
      [A.associationId, A.exerciceId],
    );
    for (const m of [ancien, recent, honoraire]) {
      await b.owner.query(
        `INSERT INTO echeances (association_id, campagne_id, membre_id, numero_periode, libelle_periode, montant_du, date_echeance)
         VALUES ($1, $2, $3, 1, 'Unique', 1000, current_date - 30)`,
        [A.associationId, campagne.rows[0]!.id, m.id],
      );
    }
    const dormance = b.app.get(DormanceService);
    const r = await dormance.passerEnDormance(A.associationId);
    expect(r.membres).toContain(ancien.id);
    for (const id of [recent.id, honoraire.id, aJour.id]) expect(r.membres).not.toContain(id);
    const fiche = await appeler(b, 'GET', `/v1/membres/${ancien.id}`, { jeton: jetonA });
    expect(fiche.json().statutAdhesion).toBe('dormant');
    expect(
      (await appeler(b, 'GET', `/v1/membres/${honoraire.id}`, { jeton: jetonA })).json().statutAdhesion,
    ).toBe('honoraire');
    const audit = await b.owner.query(
      `SELECT acteur_type, acteur_id FROM audit_log WHERE action = 'membre.passe_dormant' AND entite_id = $1`,
      [ancien.id],
    );
    expect(audit.rows).toEqual([{ acteur_type: 'systeme', acteur_id: null }]);
    // Idempotent : un second passage ne change rien ; le tenant B n'est pas touché.
    expect((await dormance.passerEnDormance(A.associationId)).membres).toEqual([]);
    expect((await dormance.passerEnDormance(B.associationId)).membres).toEqual([]);
  });

  it('E2-01 : permissions (403) — le commissaire lit mais n’écrit pas', async () => {
    const m = await creerOk({ nom: 'Lecture', prenoms: 'Seule' });
    expect((await appeler(b, 'GET', `/v1/membres/${m.id}`, { jeton: jetonCommissaire })).statusCode).toBe(
      200,
    );
    for (const [methode, url, corps] of [
      [
        'POST',
        '/v1/membres',
        { id: uuidv7(), nom: 'X', prenoms: 'Y', telephone: telephoneFictif(), consentement: CONSENTEMENT },
      ],
      ['PATCH', `/v1/membres/${m.id}`, { nom: 'X' }],
      ['POST', `/v1/membres/${m.id}/desactiver`, { motif: 'xxx' }],
      ['POST', `/v1/membres/${m.id}/anonymiser`, { motif: 'xxx' }],
      ['POST', `/v1/membres/${m.id}/doublon`, { decision: 'pas_doublon' }],
      ['POST', `/v1/membres/${m.id}/ayants-droit`, { nom: 'X', prenoms: 'Y', lien: 'enfant' }],
      ['POST', '/v1/familles', { nom: 'X' }],
    ] as const) {
      const r = await appeler(b, methode, url, { jeton: jetonCommissaire, corps });
      expect(r.statusCode, `${methode} ${url}`).toBe(403);
      expect(r.json().code).toBe('PERMISSION_REFUSEE');
    }
    // Le rôle « membre » (app mobile) ne voit pas la liste des membres.
    const jetonMembre = await jetonPourRole(b, jetonA, A.roles.membre);
    expect((await appeler(b, 'GET', '/v1/membres', { jeton: jetonMembre })).statusCode).toBe(403);
  });

  it('E2-08 : chaque endpoint membre/famille/ayant droit d’un autre tenant répond 404', async () => {
    const m = await creerOk({ nom: 'Isolé', prenoms: 'Tenant A', telephone: '+2250799999999' });
    const f = (
      await appeler(b, 'POST', '/v1/familles', { jeton: jetonA, corps: { nom: 'Famille isolée' } })
    ).json();
    const ad = (
      await appeler(b, 'POST', `/v1/membres/${m.id}/ayants-droit`, {
        jeton: jetonA,
        corps: { nom: 'Isolé', prenoms: 'Enfant', lien: 'enfant' },
      })
    ).json();
    const jpeg = multipart(IMAGES.jpeg, 'p.jpg', 'image/jpeg');
    const cas: [string, string, unknown?, Record<string, string>?][] = [
      ['GET', `/v1/membres/${m.id}`],
      ['PATCH', `/v1/membres/${m.id}`, { nom: 'Piraté' }],
      ['POST', `/v1/membres/${m.id}/suspendre`, { motif: 'Piraté' }],
      ['POST', `/v1/membres/${m.id}/reactiver`],
      ['POST', `/v1/membres/${m.id}/desactiver`, { motif: 'Piraté' }],
      ['POST', `/v1/membres/${m.id}/anonymiser`, { motif: 'Piraté' }],
      ['POST', `/v1/membres/${m.id}/doublon`, { decision: 'pas_doublon' }],
      ['POST', `/v1/membres/${m.id}/acces-app`],
      ['PUT', `/v1/membres/${m.id}/photo`, jpeg.corps, jpeg.entetes],
      ['GET', `/v1/membres/${m.id}/situation`],
      ['GET', `/v1/membres/${m.id}/historique`],
      ['GET', `/v1/membres/${m.id}/ayants-droit`],
      ['POST', `/v1/membres/${m.id}/ayants-droit`, { nom: 'X', prenoms: 'Y', lien: 'enfant' }],
      ['PATCH', `/v1/membres/${m.id}/ayants-droit/${ad.id}`, { nom: 'Piraté' }],
      ['DELETE', `/v1/membres/${m.id}/ayants-droit/${ad.id}`],
      ['PATCH', `/v1/familles/${f.id}`, { nom: 'Piratée' }],
      ['GET', `/v1/familles/${f.id}/membres`],
    ];
    for (const [methode, url, corps, entetes] of cas) {
      const r = await appeler(b, methode as 'GET', url, { jeton: jetonB, corps, entetes });
      expect(r.statusCode, `${methode} ${url}`).toBe(404);
      expect(r.json().code).toBe('INTROUVABLE');
    }
    // Listes et recherches du tenant B : aucune donnée de A.
    const liste = await appeler(b, 'GET', '/v1/membres?q=0799999999', { jeton: jetonB });
    expect(liste.json().donnees).toHaveLength(0);
    expect((await appeler(b, 'GET', '/v1/familles?q=isolee', { jeton: jetonB })).json().donnees).toHaveLength(
      0,
    );
    const refB = await creer(
      { nom: 'Ref', prenoms: 'Croisée', telephone: telephoneFictif(), familleId: f.id },
      jetonB,
    );
    expect(refB.statusCode).toBe(422);
    expect(refB.json().code).toBe('REFERENCE_INVALIDE');
    // Doublon inter-tenant impossible : même identité dans B = pas d'avertissement.
    const memeIdentite = await creer(
      { nom: 'Isolé', prenoms: 'Tenant A', telephone: '+2250799999999' },
      jetonB,
    );
    expect(memeIdentite.statusCode).toBe(201);
    // La fiche de A est intacte.
    const intacte = await appeler(b, 'GET', `/v1/membres/${m.id}`, { jeton: jetonA });
    expect(intacte.json()).toMatchObject({ nom: 'Isolé', etat: 'actif', photoUrl: null });
  });
});

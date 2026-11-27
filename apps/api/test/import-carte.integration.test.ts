import { uuidv7 } from '@assoflow/contracts';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesService } from '../src/infra/files/files.js';
import { CarteMembreService } from '../src/modules/membres/carte.service.js';
import {
  activerCompte,
  appeler,
  baseDisponible,
  connecterMobile,
  demarrer,
  jetonPourRole,
  multipart,
  telephoneFictif,
  type Banc,
} from './outils-integration.js';

/**
 * Import de membres (E3-08, RG-MBR-007), carte de membre (E3-09, RG-MBR-008), tâches asynchrones (docs/06 §7)
 * et planification de la dormance (E3-10, RG-MBR-005).
 */
describe.skipIf(!baseDisponible)('import, carte, tâches (intégration PostgreSQL)', () => {
  let b: Banc;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let jetonA: string;
  let jetonB: string;
  let jetonSecretaire: string;
  let jetonTresorier: string;

  async function attendreTache(id: string, jeton = jetonA) {
    await b.app.get(FilesService).vider();
    const r = await appeler(b, 'GET', `/v1/taches/${id}`, { jeton });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as {
      statut: string;
      progression: number;
      erreur: string | null;
      resultat: Record<string, unknown> | null;
    };
  }

  async function importer(contenu: string | Buffer, nom = 'membres.csv', jeton = jetonSecretaire) {
    const m = multipart(Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8'), nom, 'text/csv');
    return appeler(b, 'POST', '/v1/membres/import', { jeton, corps: m.corps, entetes: m.entetes });
  }

  async function creerMembre(corps: Record<string, unknown>) {
    const r = await appeler(b, 'POST', '/v1/membres', {
      jeton: jetonA,
      corps: { id: uuidv7(), consentement: { traitementDonnees: true, canal: 'console' }, ...corps },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; numero: string };
  }

  beforeAll(async () => {
    b = await demarrer();
    const telA = telephoneFictif();
    const telB = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle A Test-Import',
      sigle: 'MATI',
      village: 'Bouaké',
      region: 'Gbêkê',
      president: { telephone: telA, nom: 'Konan', prenoms: 'Adjoua' },
    });
    await b.associations.creer({
      nom: 'Mutuelle B Test-Import',
      village: 'Man',
      region: 'Tonkpi',
      president: { telephone: telB, nom: 'Gueu', prenoms: 'Pierre' },
    });
    await activerCompte(b, telA);
    await activerCompte(b, telB);
    jetonA = (await connecterMobile(b, telA)).accessToken;
    jetonB = (await connecterMobile(b, telB)).accessToken;
    jetonSecretaire = await jetonPourRole(b, jetonA, A.roles.secretaire);
    jetonTresorier = await jetonPourRole(b, jetonA, A.roles.tresorier);
  });
  afterAll(async () => b?.fermer());

  it('RG-MBR-007 : structure refusée tout de suite (422) — colonnes manquantes, vide, .xls, permission', async () => {
    const sansNom = await importer('prenoms;telephone\nAya;0707070707\n');
    expect(sansNom.statusCode).toBe(422);
    expect(sansNom.json().erreurs[0].code).toBe('COLONNE_MANQUANTE');
    const vide = await importer('nom;prenoms\n\n');
    expect(vide.json().erreurs[0].code).toBe('FICHIER_VIDE');
    const xls = await importer(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), 'vieux.xls');
    expect(xls.json().erreurs[0].code).toBe('TYPE_FICHIER_INVALIDE');
    const trop = await importer(
      `nom;prenoms;telephone\n${Array.from({ length: 5001 }, (_, i) => `N${i};P;+2250100${String(i).padStart(6, '0')}`).join('\n')}`,
    );
    expect(trop.json().erreurs[0].code).toBe('TROP_DE_LIGNES');
    // Le trésorier n'a pas membre.importer.
    expect((await importer('nom;prenoms\nA;B\n', 'x.csv', jetonTresorier)).statusCode).toBe(403);
  });

  it('parcours critique 6 : rapport exact (à créer, doublons base et fichier, erreurs) puis confirmation unique', async () => {
    const existant = await creerMembre({ nom: 'Kouamé', prenoms: 'Yao', telephone: '+2250701020304' });
    const cat = await appeler(b, 'POST', '/v1/categories-membres', {
      jeton: jetonA,
      corps: { libelle: 'Jeunes' },
    });
    expect(cat.statusCode).toBe(201);
    const lignes = [
      'Nom;Prénoms;Téléphone;Sexe;Date de naissance;Pays;Catégorie;Famille;Date d’adhésion',
      'Kouame;yao;0701020304;M;;CI;;;', // doublon de la base (accents, casse)
      'Traoré;Awa;07 05 05 05 05;Femme;12/04/1990;France;jeunes;Famille Traoré;01/01/2020',
      'Traore;Awa;+225 0705050505;F;;;;;', // doublon de la ligne précédente
      'Diallo;;0102030405;;;;;;', // prénoms manquant
      'Bamba;Ali;12;;;;;;', // téléphone invalide
      'Koné;Moussa;0708080808;X;31/02/1990;ZZZ;Inconnue;;', // plusieurs erreurs
      'Yao;Sans Téléphone;;;;;;Famille Inconnue;', // RG-MBR-002
      ';;;;;;;;', // ligne vide ignorée
      'Ouattara;Fatou;"0709090909";F;1985-06-30;CI;;Famille Traoré;',
    ];
    const r = await importer(`\uFEFF${lignes.join('\r\n')}\r\n`);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ type: 'import_membres_analyse', statut: 'en_attente' });
    const tacheId = r.json().id as string;
    // Le rapport n'est pas lisible avant la fin… et la tâche d'un autre utilisateur est introuvable.
    expect((await appeler(b, 'GET', `/v1/taches/${tacheId}`, { jeton: jetonA })).statusCode).toBe(404);
    const t = await attendreTache(tacheId, jetonSecretaire);
    expect(t.statut).toBe('terminee');
    expect(t.progression).toBe(100);
    expect(JSON.stringify(t.resultat)).not.toContain('_lignes');

    const rapport = await appeler(b, 'GET', `/v1/membres/import/${tacheId}`, { jeton: jetonSecretaire });
    expect(rapport.statusCode, rapport.body).toBe(200);
    const rp = rapport.json();
    expect(rp).toMatchObject({ lignes: 8, aCreer: 2, doublons: 2, erreurs: 4, confirmationId: null });
    const parLigne = Object.fromEntries(
      (rp.details as { ligne: number; statut: string; message: string }[]).map((d) => [d.ligne, d]),
    );
    expect(parLigne[2]).toMatchObject({
      statut: 'doublon_probable',
      message: expect.stringContaining(existant.numero),
    });
    expect(parLigne[4]).toMatchObject({
      statut: 'doublon_probable',
      message: 'Doublon probable de la ligne 3',
    });
    expect(parLigne[5]).toMatchObject({ statut: 'erreur', message: 'prénoms manquant' });
    expect(parLigne[6]!.message).toContain('téléphone « 12 » invalide');
    expect(parLigne[7]!.message).toMatch(/sexe.*date de naissance.*pays.*catégorie/);
    expect(parLigne[8]!.message).toContain('RG-MBR-002');
    expect(parLigne[3]).toBeUndefined();

    // Consentement attesté obligatoire.
    const sansAttestation = await appeler(b, 'POST', `/v1/membres/import/${tacheId}/confirmer`, {
      jeton: jetonSecretaire,
      corps: { inclureDoublons: false },
    });
    expect(sansAttestation.statusCode).toBe(422);
    const c = await appeler(b, 'POST', `/v1/membres/import/${tacheId}/confirmer`, {
      jeton: jetonSecretaire,
      corps: { inclureDoublons: true, attestationConsentement: true },
    });
    expect(c.statusCode, c.body).toBe(202);
    // Deux confirmations : refus, même en parallèle de la première.
    const deuxieme = await appeler(b, 'POST', `/v1/membres/import/${tacheId}/confirmer`, {
      jeton: jetonSecretaire,
      corps: { attestationConsentement: true },
    });
    expect(deuxieme.statusCode).toBe(409);
    const fin = await attendreTache(c.json().id as string, jetonSecretaire);
    expect(fin.statut, fin.erreur ?? '').toBe('terminee');
    expect(fin.resultat).toMatchObject({
      creees: 4,
      doublonsCrees: 2,
      ignorees: 0,
      erreurs: 0,
      famillesCreees: 1,
    });

    const awa = await b.owner.query(
      `SELECT m.telephone, m.sexe, m.date_naissance::text, m.pays_residence::text, m.date_adhesion::text,
              m.doublon_statut, f.nom AS famille, c.libelle AS categorie
         FROM membres m LEFT JOIN familles f ON f.id = m.famille_id
         LEFT JOIN categories_membres c ON c.id = m.categorie_id
        WHERE m.association_id = $1 AND m.prenoms = 'Awa' ORDER BY m.numero`,
      [A.associationId],
    );
    expect(awa.rows).toEqual([
      {
        telephone: '+2250705050505',
        sexe: 'F',
        date_naissance: '1990-04-12',
        pays_residence: 'FR',
        date_adhesion: '2020-01-01',
        doublon_statut: null,
        famille: 'Famille Traoré',
        categorie: 'Jeunes',
      },
      expect.objectContaining({ doublon_statut: 'a_verifier', famille: null }),
    ]);
    // Une seule « Famille Traoré » (créée une fois, réutilisée par Fatou) ; consentement papier ; audit.
    const familles = await b.owner.query(
      `SELECT count(*)::int AS n FROM familles WHERE association_id = $1 AND nom = 'Famille Traoré'`,
      [A.associationId],
    );
    expect(familles.rows[0].n).toBe(1);
    const consent = await b.owner.query(
      `SELECT DISTINCT c.canal FROM consentements c JOIN membres m ON m.id = c.membre_id
        WHERE m.association_id = $1 AND m.prenoms IN ('Awa', 'Fatou')`,
      [A.associationId],
    );
    expect(consent.rows).toEqual([{ canal: 'papier' }]);
    const audit = await b.owner.query(
      `SELECT apres FROM audit_log WHERE association_id = $1 AND action = 'membres.importes'`,
      [A.associationId],
    );
    expect(audit.rows[0].apres).toMatchObject({ creees: 4, erreurs: 0, fichier: 'membres.csv' });
    const rapportFinal = await appeler(b, 'GET', `/v1/membres/import/${tacheId}`, { jeton: jetonSecretaire });
    expect(rapportFinal.json().confirmationId).toBe(c.json().id);
  });

  it('XLSX : modèle téléchargeable, relu tel quel ; téléphone numérique sans 0 rétabli ; doublons exclus par défaut', async () => {
    const modele = await appeler(b, 'GET', '/v1/membres/import/modele', { jeton: jetonSecretaire });
    expect(modele.statusCode).toBe(200);
    expect(modele.headers['content-type']).toContain('spreadsheetml');
    const classeur = new ExcelJS.Workbook();
    await classeur.xlsx.load(modele.rawPayload as unknown as ArrayBuffer);
    const feuille = classeur.getWorksheet('Membres')!;
    feuille.addRow(['Assi', 'Marc', 709112233, 'M', new Date(Date.UTC(1979, 0, 2))]);
    feuille.addRow(['Assi', 'Marc', '0709112233']); // doublon de la ligne 3
    const contenu = Buffer.from(await classeur.xlsx.writeBuffer());
    const r = await importer(contenu, 'modele.xlsx');
    expect(r.statusCode, r.body).toBe(202);
    await attendreTache(r.json().id, jetonSecretaire);
    const rp = (
      await appeler(b, 'GET', `/v1/membres/import/${r.json().id}`, { jeton: jetonSecretaire })
    ).json();
    // Ligne 2 = exemple du modèle (Kouadio Aya Marie), ligne 3 = Assi, ligne 4 = doublon.
    expect(rp).toMatchObject({ lignes: 3, aCreer: 2, doublons: 1, erreurs: 0 });
    const c = await appeler(b, 'POST', `/v1/membres/import/${r.json().id}/confirmer`, {
      jeton: jetonSecretaire,
      corps: { attestationConsentement: true },
    });
    const fin = await attendreTache(c.json().id, jetonSecretaire);
    expect(fin.resultat).toMatchObject({ creees: 2, ignorees: 1 });
    const marc = await b.owner.query(
      `SELECT telephone, date_naissance::text FROM membres WHERE association_id = $1 AND prenoms = 'Marc'`,
      [A.associationId],
    );
    expect(marc.rows).toEqual([{ telephone: '+2250709112233', date_naissance: '1979-01-02' }]);
  });

  it('isolation : rapport et tâche d’un autre tenant introuvables ; confirmation d’une analyse en cours refusée', async () => {
    const r = await importer('nom;prenoms;telephone\nZ;Z;0701010199\n');
    const id = r.json().id as string;
    expect((await appeler(b, 'GET', `/v1/taches/${id}`, { jeton: jetonB })).statusCode).toBe(404);
    expect((await appeler(b, 'GET', `/v1/membres/import/${id}`, { jeton: jetonB })).statusCode).toBe(404);
    // Analyse terminée puis remise « en cours » : la confirmation doit attendre la fin de l'analyse.
    await b.app.get(FilesService).vider();
    await b.owner.query(`UPDATE taches SET statut = 'en_cours' WHERE id = $1`, [id]);
    const c = await appeler(b, 'POST', `/v1/membres/import/${id}/confirmer`, {
      jeton: jetonSecretaire,
      corps: { attestationConsentement: true },
    });
    expect(c.statusCode).toBe(409);
    const liste = await appeler(b, 'GET', '/v1/taches', { jeton: jetonSecretaire });
    expect(liste.statusCode).toBe(200);
    expect((liste.json() as { id: string }[]).map((t) => t.id)).toContain(id);
  });

  it('RG-MBR-008 : carte PDF avec QR signé sans donnée personnelle ; refus pour une fiche anonymisée', async () => {
    const m = await creerMembre({ nom: 'Coulibaly', prenoms: 'Mariam', telephone: telephoneFictif() });
    // Vrai PNG 1×1 (décodable par le moteur PDF).
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const vraie = multipart(png1x1, 'p.png', 'image/png');
    const up = await appeler(b, 'PUT', `/v1/membres/${m.id}/photo`, {
      jeton: jetonA,
      corps: vraie.corps,
      entetes: vraie.entetes,
    });
    expect(up.statusCode, up.body).toBe(200);
    const r = await appeler(b, 'GET', `/v1/membres/${m.id}/carte`, { jeton: jetonTresorier });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain(`carte-${m.numero}.pdf`);
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const cartes = b.app.get(CarteMembreService);
    const qr = cartes.contenuQr(A.associationId, m.id);
    expect(qr).toMatch(new RegExp(`^assoflow:m:${A.associationId}:${m.id}:[A-Za-z0-9_-]{22}$`));
    expect(qr).not.toContain('Coulibaly');
    expect(cartes.lireQr(qr)).toEqual({ associationId: A.associationId, membreId: m.id });
    expect(cartes.lireQr(qr.replace(m.id, uuidv7()))).toBeNull();
    expect(cartes.lireQr(`${qr.slice(0, -1)}${qr.endsWith('A') ? 'B' : 'A'}`)).toBeNull();

    expect((await appeler(b, 'GET', `/v1/membres/${m.id}/carte`, { jeton: jetonB })).statusCode).toBe(404);
    await appeler(b, 'POST', `/v1/membres/${m.id}/anonymiser`, {
      jeton: jetonA,
      corps: { motif: 'Demande' },
    });
    expect((await appeler(b, 'GET', `/v1/membres/${m.id}/carte`, { jeton: jetonA })).statusCode).toBe(409);
  });

  it('RG-MBR-005 : planification `membres.dormance` exécutée pour toutes les associations actives', async () => {
    const m = await creerMembre({ nom: 'Dormant', prenoms: 'Futur', telephone: telephoneFictif() });
    const ex = await b.owner.query<{ id: string }>(
      `INSERT INTO exercices (association_id, libelle, date_debut, date_fin)
       VALUES ($1, 'Exercice dormance', '2020-01-01', '2020-12-31') RETURNING id`,
      [A.associationId],
    );
    const camp = await b.owner.query<{ id: string }>(
      `INSERT INTO campagnes_cotisation (association_id, exercice_id, libelle, montant, periodicite, date_debut,
                                         date_fin, statut)
       VALUES ($1, $2, 'Ancienne', 1000, 'unique', '2020-01-05', '2020-01-05', 'active') RETURNING id`,
      [A.associationId, ex.rows[0]!.id],
    );
    await b.owner.query(
      `INSERT INTO echeances (association_id, campagne_id, membre_id, numero_periode, libelle_periode, montant_du,
                              date_echeance) VALUES ($1, $2, $3, 1, '2020', 1000, '2020-01-05')`,
      [A.associationId, camp.rows[0]!.id, m.id],
    );
    await b.owner.query(`UPDATE membres SET date_adhesion = '2019-01-01' WHERE id = $1`, [m.id]);
    await b.app.get(FilesService).executerPlanification('membres.dormance');
    const r = await b.owner.query(`SELECT statut_adhesion FROM membres WHERE id = $1`, [m.id]);
    expect(r.rows[0].statut_adhesion).toBe('dormant');
  });
});

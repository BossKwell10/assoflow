import { uuidv7, VERSION_SCHEMA_SYNC } from '@assoflow/contracts';
import { createHash } from 'node:crypto';
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

const mois = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
};

interface Changes {
  [table: string]: {
    created: Record<string, unknown>[];
    updated: Record<string, unknown>[];
    deleted: string[];
  };
}

interface ResultatPush {
  table: string;
  id: string;
  statut: string;
  code?: string;
  message?: string;
  serveur?: Record<string, unknown>;
}

/**
 * Synchronisation mobile (E5-01 à E5-06, docs/05) : enregistrement d'appareil, pull par curseur et par rôle,
 * push idempotent avec rejets, exigences de test du protocole (§10), révocation, versions, pièces jointes.
 */
describe.skipIf(!baseDisponible)('synchronisation mobile (intégration PostgreSQL)', () => {
  let b: Banc;
  let files: FilesService;
  let A: Awaited<ReturnType<Banc['associations']['creer']>>;
  let telPresident: string;
  let jetonA: string;
  let caisse: string;
  let campagne: string;

  /**
   * Appareil par téléphone, enregistré une fois (l'API limite les OTP à 3 par numéro et par 15 min) : OTP
   * `confirmation_appareil` puis `POST /auth/appareils` → jeton portant la claim `dev`.
   */
  const appareilsParTelephone = new Map<
    string,
    { appareil: { id: string; prefixeRecu: string }; accessToken: string }
  >();
  async function enregistrerAppareil(telephone: string, jetonMobile: string) {
    const connu = appareilsParTelephone.get(telephone);
    if (connu) return connu;
    const nouveau = await nouvelAppareil(telephone, jetonMobile);
    appareilsParTelephone.set(telephone, nouveau);
    return nouveau;
  }

  async function nouvelAppareil(telephone: string, jetonMobile: string) {
    const d = await appeler(b, 'POST', '/v1/auth/otp/demander', {
      corps: { telephone, but: 'confirmation_appareil' },
    });
    expect(d.statusCode).toBe(204);
    const v = await appeler(b, 'POST', '/v1/auth/otp/verifier', {
      corps: { telephone, code: b.sms.dernierCode(telephone), but: 'confirmation_appareil' },
    });
    expect(v.statusCode, v.body).toBe(200);
    const r = await appeler(b, 'POST', '/v1/auth/appareils', {
      jeton: jetonMobile,
      corps: { nom: 'Tecno Spark', plateforme: 'android', versionApp: '1.0.0', jetonOtp: v.json().jetonOtp },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { appareil: { id: string; prefixeRecu: string }; accessToken: string };
  }

  async function telephoneDe(jeton: string): Promise<string> {
    return (await appeler(b, 'GET', '/v1/auth/moi', { jeton })).json().telephone as string;
  }

  function pull(jeton: string, curseur = 0, extra: Record<string, unknown> = {}) {
    return appeler(b, 'POST', '/v1/sync/pull', {
      jeton,
      corps: { curseur, versionSchema: VERSION_SCHEMA_SYNC, versionApp: '1.0.0', ...extra },
    });
  }

  /** Pull complet (pages enchaînées tant que `complet = false`). */
  async function pullComplet(jeton: string, curseur = 0, limite?: number) {
    const tout: Changes = {};
    let pages = 0;
    for (;;) {
      const r = await pull(jeton, curseur, limite ? { limite } : {});
      expect(r.statusCode, r.body).toBe(200);
      pages++;
      for (const [table, c] of Object.entries(r.json().changes as Changes)) {
        tout[table] ??= { created: [], updated: [], deleted: [] };
        tout[table].updated.push(...c.updated);
        tout[table].deleted.push(...c.deleted);
      }
      curseur = r.json().curseur;
      if (r.json().complet) return { tout, curseur, pages };
    }
  }

  async function push(jeton: string, changes: Record<string, unknown>) {
    const r = await appeler(b, 'POST', '/v1/sync/push', {
      jeton,
      corps: { curseurBase: 0, versionSchema: VERSION_SCHEMA_SYNC, versionApp: '1.0.0', changes },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { resultats: ResultatPush[]; curseur: number };
  }

  const membreLocal = (extra: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    nom: 'Kouadio',
    prenoms: 'Ama',
    telephone: telephoneFictif(),
    consentement_traitement: true,
    ...extra,
  });

  const paiementLocal = (membreId: string, extra: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    membre_id: membreId,
    montant: 2000,
    mode: 'especes',
    compte_id: caisse,
    date_paiement: Date.now(),
    campagne_id: null,
    ...extra,
  });

  beforeAll(async () => {
    b = await demarrer();
    files = b.app.get(FilesService);
    telPresident = telephoneFictif();
    A = await b.associations.creer({
      nom: 'Mutuelle Test-Sync',
      village: 'Daloa',
      region: 'Haut-Sassandra',
      president: { telephone: telPresident, nom: 'Zadi', prenoms: 'Marc' },
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
    await activerCompte(b, telPresident);
    jetonA = (await connecterMobile(b, telPresident)).accessToken;
    const c = await appeler(b, 'POST', '/v1/campagnes', {
      jeton: jetonA,
      corps: {
        exerciceId: A.exerciceId,
        libelle: 'Mensuelle',
        type: 'ordinaire',
        montant: 1000,
        periodicite: 'mensuelle',
        dateDebut: mois(-1),
        dateFin: mois(1),
      },
    });
    expect(c.statusCode, c.body).toBe(201);
    campagne = c.json().id;
  });
  afterAll(async () => b?.fermer());

  it('E5-01 : enregistrement par OTP, préfixes séquentiels, jeton OTP à usage unique, rattachement ; sync exige l’appareil', async () => {
    const sans = await pull(jetonA);
    expect(sans.statusCode).toBe(403);
    expect(sans.json().code).toBe('PERMISSION_REFUSEE');

    const premier = await enregistrerAppareil(telPresident, jetonA);
    expect(premier.appareil.prefixeRecu).toBe('A01');
    const jetonT = await jetonPourRole(b, jetonA, A.roles.tresorier);
    const second = await enregistrerAppareil(await telephoneDe(jetonT), jetonT);
    expect(second.appareil.prefixeRecu).toBe('A02');

    await appeler(b, 'POST', '/v1/auth/otp/demander', {
      corps: { telephone: telPresident, but: 'confirmation_appareil' },
    });
    const v = await appeler(b, 'POST', '/v1/auth/otp/verifier', {
      corps: { telephone: telPresident, code: b.sms.dernierCode(telPresident), but: 'confirmation_appareil' },
    });
    const corps = { nom: 'Tecno', plateforme: 'android', versionApp: '1.0.1', jetonOtp: v.json().jetonOtp };
    const rattache = await appeler(b, 'POST', '/v1/auth/appareils', {
      jeton: premier.accessToken,
      corps: { ...corps, appareilId: premier.appareil.id },
    });
    expect(rattache.statusCode, rattache.body).toBe(200);
    expect(rattache.json().appareil).toMatchObject({ prefixeRecu: 'A01', versionApp: '1.0.1' });
    const rejeu = await appeler(b, 'POST', '/v1/auth/appareils', { jeton: premier.accessToken, corps });
    expect(rejeu.statusCode).toBe(401);
    expect(rejeu.json().code).toBe('OTP_INVALIDE');
    // Un code d'un autre but ne confirme pas d'appareil.
    expect((await pull(premier.accessToken)).statusCode).toBe(200);
  });

  it('E5-02 : pull initial complet puis incrémental, pagination exacte, format WatermelonDB', async () => {
    const { accessToken: jeton } = await enregistrerAppareil(telPresident, jetonA);
    for (let i = 0; i < 5; i++) {
      const r = await appeler(b, 'POST', '/v1/membres', {
        jeton: jetonA,
        corps: {
          id: uuidv7(),
          nom: `Pull${i}`,
          prenoms: 'Test',
          telephone: telephoneFictif(),
          consentement: { traitementDonnees: true, canal: 'console' },
        },
      });
      expect(r.statusCode).toBe(201);
    }
    const entier = await pullComplet(jeton);
    expect(entier.pages).toBe(1);
    expect(entier.tout.associations!.updated[0]).toMatchObject({ id: A.associationId, devise: 'XOF' });
    const m = entier.tout.membres!.updated.find((x) => x.nom === 'Pull0')!;
    expect(typeof m.created_at).toBe('number');
    expect(typeof m.date_adhesion).toBe('number');
    expect(m).not.toHaveProperty('association_id');
    expect(m).not.toHaveProperty('empreinte_creation');
    expect(entier.tout.campagnes_cotisation!.updated.map((x) => x.id)).toContain(campagne);

    // Pagination par 3 : même ensemble de lignes, sans perte ni doublon, même curseur final.
    const pagine = await pullComplet(jeton, 0, 3);
    expect(pagine.pages).toBeGreaterThan(1);
    const ids = (c: Changes) =>
      Object.entries(c)
        .filter(([t]) => t !== 'associations')
        .flatMap(([t, x]) => x.updated.map((l) => `${t}:${String(l.id)}`))
        .sort();
    expect(ids(pagine.tout)).toEqual(ids(entier.tout));
    expect(pagine.curseur).toBe(entier.curseur);

    // Incrémental : seule la modification depuis le curseur revient.
    const lu = await appeler(b, 'GET', `/v1/membres/${m.id as string}`, { jeton: jetonA });
    const modif = await appeler(b, 'PATCH', `/v1/membres/${m.id as string}`, {
      jeton: jetonA,
      corps: { lieuResidence: 'Paris', paysResidence: 'FR' },
      entetes: { 'if-match': lu.json().etag as string },
    });
    expect(modif.statusCode, modif.body).toBe(200);
    const inc = await pullComplet(jeton, entier.curseur);
    expect(inc.tout.membres!.updated.map((x) => x.id)).toEqual([m.id]);
    expect(inc.tout.membres!.updated[0]).toMatchObject({ lieu_residence: 'Paris', est_diaspora: true });
    expect(inc.tout.associations!.updated).toHaveLength(1);
  });

  it('E5-03 : push membre + paiement, numéros serveur, rejeu ×3 sans doublon (paiement, mouvement, SMS)', async () => {
    const { accessToken: jeton, appareil } = await enregistrerAppareil(telPresident, jetonA);
    const membre = membreLocal();
    const paiement = paiementLocal(membre.id, { numero_recu_provisoire: `${appareil.prefixeRecu}-000001` });
    const changes = { membres: { created: [membre] }, paiements: { created: [paiement] } };
    const r1 = await push(jeton, changes);
    expect(r1.resultats).toEqual([
      expect.objectContaining({
        table: 'membres',
        statut: 'accepte',
        serveur: { numero: expect.stringMatching(/^MBR-/) },
      }),
      expect.objectContaining({
        table: 'paiements',
        statut: 'accepte',
        serveur: { numero_recu: expect.stringMatching(/^REC-/) },
      }),
    ]);
    for (let i = 0; i < 2; i++) {
      const r = await push(jeton, changes);
      expect(r.resultats.map((x) => x.statut)).toEqual(['deja_recu', 'deja_recu']);
      expect(r.resultats[1]!.serveur).toEqual(r1.resultats[1]!.serveur);
    }
    await files.vider();
    const compte = async (sql: string) => Number((await b.owner.query(sql, [paiement.id])).rows[0].n);
    expect(await compte(`SELECT count(*) AS n FROM paiements WHERE id = $1`)).toBe(1);
    expect(await compte(`SELECT count(*) AS n FROM mouvements WHERE origine_id = $1`)).toBe(1);
    expect(await compte(`SELECT count(*) AS n FROM notifications WHERE origine_id = $1`)).toBe(1);
    expect(b.sms.dernierMessage(membre.telephone)).toContain(`(prov. ${appareil.prefixeRecu}-000001)`);
    const consentement = await b.owner.query(`SELECT canal FROM consentements WHERE membre_id = $1`, [
      membre.id,
    ]);
    expect(consentement.rows[0].canal).toBe('mobile');
    // RG-NUM-002 : numéro provisoire d'un autre appareil refusé.
    const mauvais = await push(jeton, {
      paiements: { created: [paiementLocal(membre.id, { numero_recu_provisoire: 'Z99-000001' })] },
    });
    expect(mauvais.resultats[0]).toMatchObject({ statut: 'rejete', code: 'VALIDATION' });
  });

  it('docs/05 §10 : membre rejeté + paiement qui le référence → deux rejets, le reste accepté ; rejets jusqu’à acquittement', async () => {
    const { accessToken: jeton } = await enregistrerAppareil(telPresident, jetonA);
    const valide = membreLocal({ nom: 'Valide' });
    const invalide = membreLocal({ nom: '' });
    const dependant = paiementLocal(invalide.id);
    const bon = paiementLocal(valide.id);
    const r = await push(jeton, {
      membres: { created: [valide, invalide] },
      paiements: { created: [dependant, bon], updated: [{ id: bon.id, montant: 1 }] },
    });
    const statut = (id: string, s: string) => r.resultats.find((x) => x.id === id && x.statut === s);
    expect(statut(valide.id, 'accepte')).toBeDefined();
    expect(statut(invalide.id, 'rejete')).toMatchObject({ code: 'VALIDATION' });
    expect(statut(dependant.id, 'rejete')).toMatchObject({ code: 'DEPENDANCE_REJETEE' });
    expect(statut(bon.id, 'accepte')).toBeDefined();
    expect(statut(bon.id, 'rejete')).toMatchObject({ code: 'OPERATION_INTERDITE' });

    // Même id déjà rejeté → même rejet, sans retraitement.
    const encore = await push(jeton, { membres: { created: [{ ...invalide, nom: 'Corrigé' }] } });
    expect(encore.resultats[0]).toMatchObject({ statut: 'rejete', code: 'VALIDATION' });

    const p = await pull(jeton, 0);
    const rejets = p.json().rejets as { id: string; elementId: string }[];
    expect(rejets.map((x) => x.elementId)).toEqual(
      expect.arrayContaining([invalide.id, dependant.id, bon.id]),
    );
    const vueConsole = await appeler(b, 'GET', '/v1/sync/rejets', { jeton: jetonA });
    expect(vueConsole.statusCode).toBe(200);
    expect(vueConsole.json().donnees.length).toBeGreaterThanOrEqual(3);
    for (const x of rejets) {
      expect((await appeler(b, 'POST', `/v1/sync/rejets/${x.id}/acquitter`, { jeton })).statusCode).toBe(204);
    }
    expect((await pull(jeton, 0)).json().rejets).toEqual([]);
  });

  it('docs/05 §10 : deux appareils poussent 50 paiements chacun en même temps → 100 reçus sans trou, pull sans perte', async () => {
    const jetonT = await jetonPourRole(b, jetonA, A.roles.tresorier);
    const d1 = await enregistrerAppareil(telPresident, jetonA);
    const d2 = await enregistrerAppareil(await telephoneDe(jetonT), jetonT);
    const membre = membreLocal({ nom: 'Concurrent' });
    expect((await push(d1.accessToken, { membres: { created: [membre] } })).resultats[0]!.statut).toBe(
      'accepte',
    );
    const avant = await pullComplet(d1.accessToken);
    const lot = () => Array.from({ length: 50 }, () => paiementLocal(membre.id, { montant: 100 }));
    const [r1, r2] = await Promise.all([
      push(d1.accessToken, { paiements: { created: lot() } }),
      push(d2.accessToken, { paiements: { created: lot() } }),
    ]);
    const tous = [...r1.resultats, ...r2.resultats];
    expect(tous.every((x) => x.statut === 'accepte')).toBe(true);
    const recus = tous.map((x) => Number(String(x.serveur!.numero_recu).split('-')[2])).sort((x, y) => x - y);
    expect(recus).toHaveLength(100);
    expect(recus.every((n, i) => i === 0 || n === recus[i - 1]! + 1)).toBe(true);
    const apres = await pullComplet(d1.accessToken, avant.curseur, 30);
    const ids = new Set(apres.tout.paiements!.updated.map((x) => x.id));
    expect(tous.every((x) => ids.has(x.id))).toBe(true);
  });

  it('docs/05 §5.2 : horloge en avance de plus de 10 min remplacée par l’heure serveur et tracée', async () => {
    const { accessToken: jeton } = await enregistrerAppareil(telPresident, jetonA);
    const membre = membreLocal({ nom: 'Horloge' });
    const futur = paiementLocal(membre.id, { date_paiement: Date.now() + 3 * 3600_000 });
    const r = await push(jeton, { membres: { created: [membre] }, paiements: { created: [futur] } });
    expect(r.resultats[1]!.statut).toBe('accepte');
    const p = await b.owner.query(`SELECT date_paiement FROM paiements WHERE id = $1`, [futur.id]);
    expect(Math.abs((p.rows[0].date_paiement as Date).getTime() - Date.now())).toBeLessThan(60_000);
    const audit = await b.owner.query(
      `SELECT apres FROM audit_log WHERE entite_id = $1 AND action = 'paiement.enregistre'`,
      [futur.id],
    );
    expect(audit.rows[0].apres).toMatchObject({
      source: 'synchronisation',
      dateDeclareeParAppareil: expect.any(String),
    });
  });

  it('E5-02 : vue « membre » limitée à sa fiche ; changement de rôle → resynchronisation complète', async () => {
    const tel = telephoneFictif();
    const fiche = await appeler(b, 'POST', '/v1/membres', {
      jeton: jetonA,
      corps: {
        id: uuidv7(),
        nom: 'Simple',
        prenoms: 'Membre',
        telephone: tel,
        consentement: { traitementDonnees: true, canal: 'console' },
      },
    });
    const acces = await appeler(b, 'POST', `/v1/membres/${fiche.json().id}/acces-app`, { jeton: jetonA });
    expect(acces.statusCode, acces.body).toBeLessThan(300);
    await activerCompte(b, tel);
    const jetonM = (await connecterMobile(b, tel)).accessToken;
    const { accessToken: dev } = await enregistrerAppareil(tel, jetonM);
    const vue = await pullComplet(dev);
    expect(vue.tout.membres!.updated.map((x) => x.id)).toEqual([fiche.json().id]);
    expect(vue.tout.exercices).toBeUndefined();
    expect(vue.tout.mouvements).toBeUndefined();

    const accesId = (
      await b.owner.query<{ id: string }>(
        `SELECT a.id FROM acces_association a JOIN users u ON u.id = a.user_id
          WHERE u.telephone = $1 AND a.association_id = $2 AND a.statut = 'actif'`,
        [tel, A.associationId],
      )
    ).rows[0]!.id;
    const role = await appeler(b, 'PATCH', `/v1/acces/${accesId}`, {
      jeton: jetonA,
      corps: { roleId: A.roles.tresorier },
    });
    expect(role.statusCode, role.body).toBe(200);
    const reinit = await pull(dev, vue.curseur);
    expect(reinit.json()).toMatchObject({ reinitialiser: true, curseur: 0, changes: {} });
    const complet = await pullComplet(dev, 0);
    expect(complet.tout.membres!.updated.length).toBeGreaterThan(1);
  });

  it('docs/05 §8 : versions minimales, taille de lot, tenant suspendu (push refusé, pull permis)', async () => {
    const { accessToken: jeton } = await enregistrerAppareil(telPresident, jetonA);
    const vieille = await pull(jeton, 0, { versionApp: '0.9.0' });
    expect(vieille.statusCode).toBe(426);
    expect(vieille.json().code).toBe('APP_OBSOLETE');
    expect((await pull(jeton, 0, { versionSchema: 99 })).json().code).toBe('SCHEMA_OBSOLETE');
    const trop = await appeler(b, 'POST', '/v1/sync/push', {
      jeton,
      corps: {
        curseurBase: 0,
        versionSchema: VERSION_SCHEMA_SYNC,
        changes: { membres: { created: Array.from({ length: 501 }, () => membreLocal()) } },
      },
    });
    expect(trop.statusCode).toBe(422);

    await b.owner.query(`UPDATE associations SET statut = 'suspendue' WHERE id = $1`, [A.associationId]);
    try {
      expect((await pull(jeton, 0)).statusCode).toBe(200);
      const p = await appeler(b, 'POST', '/v1/sync/push', {
        jeton,
        corps: { curseurBase: 0, versionSchema: VERSION_SCHEMA_SYNC, changes: {} },
      });
      expect(p.statusCode).toBe(423);
      expect(p.json().code).toBe('TENANT_SUSPENDU');
    } finally {
      await b.owner.query(`UPDATE associations SET statut = 'active' WHERE id = $1`, [A.associationId]);
    }
  });

  it('E5-05 : pièce jointe déclarée, envoyée par URL présignée, vérifiée (taille, SHA-256, type)', async () => {
    const { accessToken: jeton } = await enregistrerAppareil(telPresident, jetonA);
    const membre = membreLocal({ nom: 'Photo' });
    await push(jeton, { membres: { created: [membre] } });
    const fichier = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 7)]);
    const sha = createHash('sha256').update(fichier).digest('hex');
    const pieceId = uuidv7();
    const r = await push(jeton, {
      pieces_jointes: {
        created: [
          {
            id: pieceId,
            entite_type: 'membre',
            entite_id: membre.id,
            mime: 'application/pdf',
            taille_octets: fichier.length,
            sha256: sha,
          },
        ],
      },
    });
    expect(r.resultats[0]).toMatchObject({ statut: 'accepte', serveur: { statut_upload: 'en_attente' } });

    const absent = await appeler(b, 'POST', `/v1/pieces-jointes/${pieceId}/confirmer`, { jeton });
    expect(absent.statusCode).toBe(422);
    expect(absent.json().erreurs[0].code).toBe('FICHIER_ABSENT');
    const url = await appeler(b, 'POST', `/v1/pieces-jointes/${pieceId}/url-upload`, { jeton });
    expect(url.statusCode, url.body).toBe(200);
    expect(url.json()).toMatchObject({ methode: 'PUT', entetes: { 'content-type': 'application/pdf' } });
    const cible = new URL(url.json().url as string);
    const envoi = await b.app.inject({
      method: 'PUT',
      url: `${cible.pathname}${cible.search}`,
      headers: { 'content-type': 'application/pdf' },
      payload: fichier,
    });
    expect(envoi.statusCode, envoi.body).toBe(200);
    const ok = await appeler(b, 'POST', `/v1/pieces-jointes/${pieceId}/confirmer`, { jeton });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().statutUpload).toBe('recu');
    const lecture = await appeler(b, 'GET', `/v1/pieces-jointes/${pieceId}/url-telechargement`, { jeton });
    expect(lecture.json()).toMatchObject({ methode: 'GET' });

    // URL signée falsifiée → 404 ; empreinte différente → pièce rejetée.
    const falsifie = await b.app.inject({
      method: 'PUT',
      url: `${cible.pathname}${cible.search.replace('sig=', 'sig=x')}`,
      headers: { 'content-type': 'application/pdf' },
      payload: fichier,
    });
    expect(falsifie.statusCode).toBe(404);
    const faux = uuidv7();
    const d = await appeler(b, 'POST', '/v1/pieces-jointes', {
      jeton,
      corps: {
        id: faux,
        entiteType: 'membre',
        entiteId: membre.id,
        mime: 'application/pdf',
        tailleOctets: fichier.length,
        sha256: 'a'.repeat(64),
      },
    });
    expect(d.statusCode, d.body).toBe(201);
    const u2 = new URL(
      (await appeler(b, 'POST', `/v1/pieces-jointes/${faux}/url-upload`, { jeton })).json().url,
    );
    await b.app.inject({
      method: 'PUT',
      url: `${u2.pathname}${u2.search}`,
      headers: { 'content-type': 'application/pdf' },
      payload: fichier,
    });
    const rejet = await appeler(b, 'POST', `/v1/pieces-jointes/${faux}/confirmer`, { jeton });
    expect(rejet.statusCode).toBe(422);
    expect(rejet.json().erreurs[0].code).toBe('EMPREINTE_DIFFERENTE');
  });

  it('E5-06 / A32 : liste des appareils, révocation avec purge → 401 APPAREIL_REVOQUE à la requête suivante', async () => {
    const jetonS = await jetonPourRole(b, jetonA, A.roles.secretaire);
    const { accessToken: jeton, appareil } = await nouvelAppareil(await telephoneDe(jetonS), jetonS);
    await pull(jeton, 0, { elementsEnAttente: 7 });
    const liste = await appeler(b, 'GET', '/v1/appareils', { jeton: jetonA });
    expect(liste.statusCode).toBe(200);
    expect(liste.json().find((x: { id: string }) => x.id === appareil.id)).toMatchObject({
      elementsEnAttente: 7,
      revoqueAt: null,
      utilisateur: { nom: expect.any(String) },
    });
    const jetonT = await jetonPourRole(b, jetonA, A.roles.tresorier);
    const interdit = await appeler(b, 'POST', `/v1/appareils/${appareil.id}/revoquer`, {
      jeton: jetonT,
      corps: { motif: 'Téléphone perdu' },
    });
    expect(interdit.statusCode).toBe(403);
    const rev = await appeler(b, 'POST', `/v1/appareils/${appareil.id}/revoquer`, {
      jeton: jetonA,
      corps: { motif: 'Téléphone perdu', purger: true },
    });
    expect(rev.statusCode, rev.body).toBe(204);
    const refus = await pull(jeton, 0);
    expect(refus.statusCode).toBe(401);
    expect(refus.json()).toMatchObject({ code: 'APPAREIL_REVOQUE', erreurs: [{ code: 'PURGE_DEMANDEE' }] });
    const deux = await appeler(b, 'POST', `/v1/appareils/${appareil.id}/revoquer`, {
      jeton: jetonA,
      corps: { motif: 'Encore' },
    });
    expect(deux.statusCode).toBe(409);
  });
});

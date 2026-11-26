import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activerCompte,
  appeler,
  baseDisponible,
  claims,
  codeTotp,
  connecterMobile,
  demarrer,
  MOT_DE_PASSE,
  telephoneFictif,
  type Banc,
} from './outils-integration.js';

/**
 * Authentification de bout en bout sur PostgreSQL (E1-01 à E1-09) via `app.inject`.
 * Nécessite DATABASE_URL et DATABASE_APP_URL (base migrée) ; sinon ignoré.
 */
describe.skipIf(!baseDisponible)('authentification (intégration PostgreSQL)', () => {
  let b: Banc;
  const telPresident = telephoneFictif();
  let associationId: string;
  let presidentId: string;

  beforeAll(async () => {
    b = await demarrer();
    const a = await b.associations.creer({
      nom: 'Mutuelle des ressortissants de Test-Auth',
      village: 'Kossou',
      region: 'Bélier',
      president: { telephone: telPresident, nom: 'Kouassi', prenoms: 'Aya Test' },
    });
    associationId = a.associationId;
    presidentId = a.presidentUserId;
  });
  afterAll(async () => b?.fermer());

  describe('parcours complet invitation → OTP → mot de passe → connexion → TOTP → contexte → /moi', () => {
    let jetonOtp: string;
    let secretTotp: string;
    let codesSecours: string[];
    let accessToken: string;

    it('RG-ASS-001 : le tenant est créé avec rôles, président, caisse, catégories et exercice', async () => {
      const q = (sql: string) => b.owner.query(sql, [associationId]).then((r) => r.rows);
      expect(
        (await q(`SELECT code FROM roles WHERE association_id = $1 AND systeme ORDER BY code`)).map(
          (r) => r.code,
        ),
      ).toEqual(['commissaire', 'membre', 'president', 'secretaire', 'tresorier']);
      expect(await q(`SELECT libelle FROM comptes_tresorerie WHERE association_id = $1`)).toEqual([
        { libelle: 'Caisse' },
      ]);
      expect(await q(`SELECT count(*)::int AS n FROM categories_depense WHERE association_id = $1`)).toEqual([
        { n: 4 },
      ]);
      expect(await q(`SELECT libelle FROM categories_membres WHERE association_id = $1`)).toEqual([
        { libelle: 'Membre ordinaire' },
      ]);
      const [ex] = await q(
        `SELECT (current_date BETWEEN date_debut AND date_fin) AS couvre FROM exercices WHERE association_id = $1`,
      );
      expect(ex.couvre).toBe(true);
      const [acces] = await q(
        `SELECT r.code FROM acces_association a JOIN roles r ON r.id = a.role_id WHERE a.association_id = $1 AND a.statut = 'actif'`,
      );
      expect(acces.code).toBe('president');
    });

    it('E1-01 : un OTP est envoyé et stocké haché (HMAC), jamais en clair', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/otp/demander', {
        corps: { telephone: telPresident, but: 'inscription' },
      });
      expect(r.statusCode).toBe(204);
      const code = b.sms.dernierCode(telPresident)!;
      expect(code).toMatch(/^\d{6}$/);
      const { rows } = await b.owner.query(
        `SELECT code_hash, expire_at - created_at AS duree FROM otp_codes WHERE telephone = $1 ORDER BY created_at DESC LIMIT 1`,
        [telPresident],
      );
      expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].code_hash).not.toContain(code);
      expect(rows[0].duree).toMatchObject({ minutes: 5 });
      const v = await appeler(b, 'POST', '/v1/auth/otp/verifier', {
        corps: { telephone: telPresident, code, but: 'inscription' },
      });
      expect(v.statusCode).toBe(200);
      jetonOtp = v.json().jetonOtp;
      expect(jetonOtp).toBeTruthy();
    });

    it('E1-09 : les consentements CGU et données sont exigés à la définition du mot de passe', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/mot-de-passe', {
        corps: { jetonOtp, motDePasse: MOT_DE_PASSE },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe('VALIDATION');
      expect(r.json().erreurs.map((e: { champ: string }) => e.champ)).toEqual([
        'accepteCgu',
        'accepteTraitementDonnees',
      ]);
    });

    it('RF-SUP-053 : un mot de passe faible est refusé (MOT_DE_PASSE_FAIBLE)', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/mot-de-passe', {
        corps: {
          jetonOtp,
          motDePasse: `Mdp${telPresident.slice(-8)}`,
          accepteCgu: true,
          accepteTraitementDonnees: true,
        },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({
        code: 'MOT_DE_PASSE_FAIBLE',
        erreurs: [{ champ: 'motDePasse', code: 'SUITE_TELEPHONE' }],
      });
    });

    it('E1-01, E1-09 : le mot de passe est défini (argon2id) et les consentements enregistrés', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/mot-de-passe', {
        corps: {
          jetonOtp,
          motDePasse: MOT_DE_PASSE,
          accepteCgu: true,
          accepteTraitementDonnees: true,
          canal: 'console',
        },
      });
      expect(r.statusCode).toBe(204);
      const u = await b.owner.query(`SELECT mot_de_passe_hash FROM users WHERE id = $1`, [presidentId]);
      expect(u.rows[0].mot_de_passe_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      const c = await b.owner.query(
        `SELECT type, accorde, canal FROM consentements WHERE user_id = $1 ORDER BY type`,
        [presidentId],
      );
      expect(c.rows).toEqual([
        { type: 'cgu', accorde: true, canal: 'console' },
        { type: 'traitement_donnees', accorde: true, canal: 'console' },
      ]);
    });

    it('le jeton OTP est à usage unique', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/mot-de-passe', {
        corps: {
          jetonOtp,
          motDePasse: 'Autre-Mot-De-Passe-2027',
          accepteCgu: true,
          accepteTraitementDonnees: true,
        },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('OTP_INVALIDE');
    });

    it('E1-02, E1-03 : sur la console, un membre du bureau sans TOTP doit l’activer', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/connexion', {
        corps: { identifiant: telPresident, motDePasse: MOT_DE_PASSE, canal: 'console' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().etape).toBe('totp_activation');
      const intermediaire = r.json().jetonIntermediaire as string;

      // Le jeton intermédiaire n'ouvre aucune autre route.
      expect((await appeler(b, 'GET', '/v1/auth/moi', { jeton: intermediaire })).statusCode).toBe(401);

      const act = await appeler(b, 'POST', '/v1/auth/totp/activation', { jeton: intermediaire });
      expect(act.statusCode).toBe(200);
      secretTotp = act.json().secret;
      expect(act.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const stocke = await b.owner.query(`SELECT totp_secret_chiffre, totp_actif FROM users WHERE id = $1`, [
        presidentId,
      ]);
      expect(stocke.rows[0].totp_actif).toBe(false);
      expect(stocke.rows[0].totp_secret_chiffre.includes(Buffer.from(secretTotp))).toBe(false);

      const mauvais = await appeler(b, 'POST', '/v1/auth/totp/confirmation', {
        jeton: intermediaire,
        corps: { code: codeTotp(secretTotp, Date.now() - 10 * 60_000) },
      });
      expect(mauvais.statusCode).toBe(422);

      const conf = await appeler(b, 'POST', '/v1/auth/totp/confirmation', {
        jeton: intermediaire,
        corps: { code: codeTotp(secretTotp) },
      });
      expect(conf.statusCode, conf.body).toBe(200);
      codesSecours = conf.json().codesSecours;
      expect(codesSecours).toHaveLength(10);
      const session = conf.json().session;
      expect(session.refreshToken).toBeUndefined();
      expect(String(conf.headers['set-cookie'])).toMatch(
        /^assoflow_refresh=[\w-]+; Max-Age=\d+; Path=\/v1\/auth; HttpOnly; Secure; SameSite=Strict$/,
      );
      accessToken = session.accessToken;
      expect(session.expireDans).toBe(600);
      // Une seule association : contexte choisi d'office.
      expect(claims(accessToken)).toMatchObject({ sub: presidentId, aid: associationId, can: 'console' });
      const hashes = await b.owner.query(`SELECT codes_secours_hash FROM users WHERE id = $1`, [presidentId]);
      expect(hashes.rows[0].codes_secours_hash).toHaveLength(10);
      expect(hashes.rows[0].codes_secours_hash).not.toContain(codesSecours[0]);
    });

    it('E1-07 : /auth/contexte choisit l’association active', async () => {
      const r = await appeler(b, 'POST', '/v1/auth/contexte', {
        jeton: accessToken,
        corps: { associationId },
      });
      expect(r.statusCode).toBe(200);
      accessToken = r.json().accessToken;
      expect(claims(accessToken).aid).toBe(associationId);
      const autre = await appeler(b, 'POST', '/v1/auth/contexte', {
        jeton: accessToken,
        corps: { associationId: crypto.randomUUID() },
      });
      expect(autre.statusCode).toBe(403);
      expect(autre.json().code).toBe('ACCES_REVOQUE');
    });

    it('/auth/moi renvoie le profil et les accès avec permissions', async () => {
      const r = await appeler(b, 'GET', '/v1/auth/moi', { jeton: accessToken });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        id: presidentId,
        telephone: telPresident,
        totpActif: true,
        rolePlateforme: null,
        acces: [{ associationId, role: { code: 'president' } }],
      });
      expect(r.json().acces[0].permissions).toContain('utilisateur.gerer');
      expect(r.json()).not.toHaveProperty('motDePasseHash');
    });

    it('E1-03 : connexion suivante par TOTP ou code de secours (usage unique)', async () => {
      const connexion = async () =>
        (
          await appeler(b, 'POST', '/v1/auth/connexion', {
            corps: { identifiant: telPresident, motDePasse: MOT_DE_PASSE, canal: 'console' },
          })
        ).json();
      const etape = await connexion();
      expect(etape.etape).toBe('totp');
      // Le code TOTP déjà utilisé à la confirmation est refusé (anti-rejeu RFC 6238).
      const rejeu = await appeler(b, 'POST', '/v1/auth/totp', {
        corps: { jetonIntermediaire: etape.jetonIntermediaire, code: codeTotp(secretTotp) },
      });
      expect(rejeu.statusCode).toBe(401);
      expect(rejeu.json().code).toBe('TOTP_INVALIDE');

      const secours = await appeler(b, 'POST', '/v1/auth/totp', {
        corps: { jetonIntermediaire: etape.jetonIntermediaire, code: codesSecours[0]!.toUpperCase() },
      });
      expect(secours.statusCode).toBe(200);
      expect(secours.json().accessToken).toBeTruthy();

      const encore = await appeler(b, 'POST', '/v1/auth/totp', {
        corps: { jetonIntermediaire: (await connexion()).jetonIntermediaire, code: codesSecours[0] },
      });
      expect(encore.statusCode).toBe(401);
    });

    it('E1-02 : connexion par email (insensible à la casse) ; message unique en cas d’erreur', async () => {
      await b.owner.query(`UPDATE users SET email = $2 WHERE id = $1`, [
        presidentId,
        `aya.${presidentId}@exemple.ci`,
      ]);
      const ok = await appeler(b, 'POST', '/v1/auth/connexion', {
        corps: { identifiant: `AYA.${presidentId}@exemple.ci`, motDePasse: MOT_DE_PASSE, canal: 'mobile' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().refreshToken).toBeTruthy();
      const inconnu = await appeler(b, 'POST', '/v1/auth/connexion', {
        corps: { identifiant: telephoneFictif(), motDePasse: MOT_DE_PASSE, canal: 'console' },
      });
      const faux = await appeler(b, 'POST', '/v1/auth/connexion', {
        corps: { identifiant: telPresident, motDePasse: 'Mauvais-Mot-De-Passe', canal: 'console' },
      });
      for (const r of [inconnu, faux]) {
        expect(r.statusCode).toBe(401);
        expect(r.json()).toMatchObject({
          code: 'IDENTIFIANTS_INVALIDES',
          detail: 'Identifiant ou mot de passe incorrect',
        });
      }
      await b.owner.query(`UPDATE users SET echecs_connexion = 0 WHERE id = $1`, [presidentId]);
    });

    it('E1-06 : console, refresh par cookie + X-Requested-With, puis déconnexion', async () => {
      const etape = (
        await appeler(b, 'POST', '/v1/auth/connexion', {
          corps: { identifiant: telPresident, motDePasse: MOT_DE_PASSE, canal: 'console' },
        })
      ).json();
      const r = await appeler(b, 'POST', '/v1/auth/totp', {
        corps: { jetonIntermediaire: etape.jetonIntermediaire, code: codesSecours[1] },
      });
      const cookie = String(r.headers['set-cookie']).split(';')[0]!;
      const sansEntete = await appeler(b, 'POST', '/v1/auth/refresh', { corps: {}, entetes: { cookie } });
      expect(sansEntete.statusCode).toBe(401);
      const ok = await appeler(b, 'POST', '/v1/auth/refresh', {
        corps: {},
        entetes: { cookie, 'x-requested-with': 'assoflow-console' },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().refreshToken).toBeUndefined();
      expect(claims(ok.json().accessToken).aid).toBe(associationId);
      const nouveauCookie = String(ok.headers['set-cookie']).split(';')[0]!;
      expect(nouveauCookie).not.toBe(cookie);

      const dec = await appeler(b, 'POST', '/v1/auth/deconnexion', { jeton: ok.json().accessToken });
      expect(dec.statusCode).toBe(204);
      expect(String(dec.headers['set-cookie'])).toMatch(/^assoflow_refresh=; Max-Age=0;/);
      expect((await appeler(b, 'GET', '/v1/auth/moi', { jeton: ok.json().accessToken })).json().code).toBe(
        'SESSION_REVOQUEE',
      );
      const apres = await appeler(b, 'POST', '/v1/auth/refresh', {
        corps: {},
        entetes: { cookie: nouveauCookie, 'x-requested-with': 'assoflow-console' },
      });
      expect(apres.statusCode).toBe(401);
    });
  });

  describe('OTP : limites', () => {
    it('3 demandes par numéro par 15 min, puis 429 avec Retry-After', async () => {
      const tel = telephoneFictif();
      await b.associations.creer({
        nom: 'Association Test OTP',
        village: 'Sakassou',
        region: 'Gbêkê',
        president: { telephone: tel, nom: 'Yao', prenoms: 'Koffi' },
      });
      for (let i = 0; i < 3; i++) {
        expect(
          (await appeler(b, 'POST', '/v1/auth/otp/demander', { corps: { telephone: tel, but: 'connexion' } }))
            .statusCode,
        ).toBe(204);
      }
      const r = await appeler(b, 'POST', '/v1/auth/otp/demander', {
        corps: { telephone: tel, but: 'connexion' },
      });
      expect(r.statusCode).toBe(429);
      expect(r.json().code).toBe('TROP_DE_REQUETES');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('5 essais par code : au-delà, même le bon code est refusé', async () => {
      const tel = telephoneFictif();
      await b.associations.creer({
        nom: 'Association Test OTP 2',
        village: 'Béoumi',
        region: 'Gbêkê',
        president: { telephone: tel, nom: 'Yao', prenoms: 'Akissi' },
      });
      await appeler(b, 'POST', '/v1/auth/otp/demander', { corps: { telephone: tel, but: 'inscription' } });
      const code = b.sms.dernierCode(tel)!;
      const faux = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const r = await appeler(b, 'POST', '/v1/auth/otp/verifier', {
          corps: { telephone: tel, code: faux, but: 'inscription' },
        });
        expect(r.json().code).toBe('OTP_INVALIDE');
      }
      const r = await appeler(b, 'POST', '/v1/auth/otp/verifier', {
        corps: { telephone: tel, code, but: 'inscription' },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('OTP_INVALIDE');
    });

    it('un numéro inconnu reçoit la même réponse, sans SMS', async () => {
      const tel = telephoneFictif();
      const r = await appeler(b, 'POST', '/v1/auth/otp/demander', {
        corps: { telephone: tel, but: 'inscription' },
      });
      expect(r.statusCode).toBe(204);
      expect(b.sms.dernierMessage(tel)).toBeUndefined();
    });
  });

  describe('RF-005 : verrouillage', () => {
    it('5 échecs → 423 COMPTE_VERROUILLE 15 min, même avec le bon mot de passe ; puis doublement', async () => {
      const tel = telephoneFictif();
      const a = await b.associations.creer({
        nom: 'Association Test Verrou',
        village: 'Tiébissou',
        region: 'Bélier',
        president: { telephone: tel, nom: 'Konan', prenoms: 'Ange' },
      });
      await activerCompte(b, tel);
      const tenter = (motDePasse: string) =>
        appeler(b, 'POST', '/v1/auth/connexion', {
          corps: { identifiant: tel, motDePasse, canal: 'mobile' },
        });
      for (let i = 0; i < 4; i++) expect((await tenter('Mauvais-Mot-De-Passe')).statusCode).toBe(401);
      const cinquieme = await tenter('Mauvais-Mot-De-Passe');
      expect(cinquieme.statusCode).toBe(423);
      expect(cinquieme.json().code).toBe('COMPTE_VERROUILLE');
      const bon = await tenter(MOT_DE_PASSE);
      expect(bon.statusCode).toBe(423);
      expect(Number(bon.headers['retry-after'])).toBeGreaterThan(14 * 60);
      expect(Number(bon.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);

      const audit = await b.owner.query(
        `SELECT action FROM audit_log WHERE association_id IS NULL AND acteur_id = $1 ORDER BY id`,
        [a.presidentUserId],
      );
      const actions = audit.rows.map((r) => r.action);
      expect(actions.filter((x) => x === 'connexion.echouee')).toHaveLength(6);
      expect(actions).toContain('utilisateur.verrouille');
      expect(JSON.stringify(audit.rows)).not.toContain('Mauvais-Mot-De-Passe');

      // Fin du premier verrouillage simulée : le suivant dans les 24 h dure 30 min.
      await b.owner.query(`UPDATE users SET verrouille_jusqua = now() - interval '1 second' WHERE id = $1`, [
        a.presidentUserId,
      ]);
      for (let i = 0; i < 4; i++) expect((await tenter('Mauvais-Mot-De-Passe')).statusCode).toBe(401);
      const second = await tenter('Mauvais-Mot-De-Passe');
      expect(second.statusCode).toBe(423);
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(29 * 60);
    });
  });

  describe('E1-06 : rotation du refresh token (mobile)', () => {
    it('chaque usage renouvelle le refresh ; la réutilisation révoque toute la famille', async () => {
      const tel = telephoneFictif();
      await b.associations.creer({
        nom: 'Association Test Refresh',
        village: 'Didiévi',
        region: 'Bélier',
        president: { telephone: tel, nom: 'Kouadio', prenoms: 'Marc' },
      });
      await activerCompte(b, tel);
      const s0 = await connecterMobile(b, tel);
      expect(s0.expireDans).toBe(900);
      const r1 = await appeler(b, 'POST', '/v1/auth/refresh', { corps: { refreshToken: s0.refreshToken } });
      expect(r1.statusCode).toBe(200);
      const s1 = r1.json();
      expect(s1.refreshToken).not.toBe(s0.refreshToken);

      // Un attaquant rejoue l'ancien refresh : toute la famille est révoquée.
      const vol = await appeler(b, 'POST', '/v1/auth/refresh', { corps: { refreshToken: s0.refreshToken } });
      expect(vol.statusCode).toBe(401);
      expect(vol.json().code).toBe('SESSION_REVOQUEE');
      const legitime = await appeler(b, 'POST', '/v1/auth/refresh', {
        corps: { refreshToken: s1.refreshToken },
      });
      expect(legitime.statusCode).toBe(401);
      expect((await appeler(b, 'GET', '/v1/auth/moi', { jeton: s1.accessToken })).json().code).toBe(
        'SESSION_REVOQUEE',
      );

      const trace = await b.owner.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'session.reutilisation_detectee' AND acteur_id = $1`,
        [s0.utilisateur.id],
      );
      expect(trace.rows[0].n).toBe(1);
    });

    it('un refresh mobile n’est pas accepté par le canal console (et inversement)', async () => {
      const tel = telephoneFictif();
      await b.associations.creer({
        nom: 'Association Test Canal',
        village: 'Bouaké',
        region: 'Gbêkê',
        president: { telephone: tel, nom: 'Kra', prenoms: 'Paul' },
      });
      await activerCompte(b, tel);
      const s = await connecterMobile(b, tel);
      const r = await appeler(b, 'POST', '/v1/auth/refresh', {
        corps: {},
        entetes: { cookie: `assoflow_refresh=${s.refreshToken}`, 'x-requested-with': 'assoflow-console' },
      });
      expect(r.statusCode).toBe(401);
    });
  });

  describe('E2-02 : audit chaîné', () => {
    it('les traces du tenant et de la plateforme sont chaînées et recalculables', async () => {
      for (const filtre of ['association_id = $1', 'association_id IS NULL']) {
        const { rows } = await b.owner.query(
          `SELECT hash_precedent, hash,
                  encode(digest(hash_precedent || '|' || coalesce(association_id::text,'') || '|' ||
                    coalesce(acteur_id::text,'') || '|' || action || '|' || entite_type || '|' ||
                    coalesce(entite_id,'') || '|' || coalesce(avant::text,'') || '|' ||
                    coalesce(apres::text,'') || '|' || created_at::text, 'sha256'), 'hex') AS recalcule
             FROM audit_log WHERE ${filtre} ORDER BY id`,
          filtre.includes('$1') ? [associationId] : [],
        );
        expect(rows.length).toBeGreaterThan(1);
        rows.forEach((r, i) => {
          expect(r.hash).toBe(r.recalcule);
          if (i > 0) expect(r.hash_precedent).toBe(rows[i - 1].hash);
        });
      }
      const actions = (
        await b.owner.query(`SELECT action FROM audit_log WHERE association_id = $1 ORDER BY id`, [
          associationId,
        ])
      ).rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['association.creee', 'session.contexte_choisi']));
      const plateforme = (
        await b.owner.query(`SELECT action FROM audit_log WHERE association_id IS NULL AND acteur_id = $1`, [
          presidentId,
        ])
      ).rows.map((r) => r.action);
      expect(plateforme).toEqual(
        expect.arrayContaining([
          'utilisateur.mot_de_passe_defini',
          'utilisateur.totp_active',
          'connexion.reussie',
          'connexion.echouee',
        ]),
      );
    });
  });
});

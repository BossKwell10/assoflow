import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { decodeJwt } from 'jose';
import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect } from 'vitest';
import { creerApplication } from '../src/bootstrap.js';
import { FOURNISSEUR_SMS } from '../src/infra/sms/fournisseur-sms.js';
import type { JournalSms } from '../src/infra/sms/journal-sms.js';
import { AssociationsService } from '../src/modules/associations/associations.service.js';
import { decoderBase32, totp } from '../src/modules/auth/domain/totp.js';

/** Les tests d'intégration exigent une base migrée (DATABASE_URL propriétaire, DATABASE_APP_URL applicatif). */
export const baseDisponible = Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL);

export const MOT_DE_PASSE = 'Lagune-Kossou-2027!';

/** Téléphone fictif (+225 01 xx xx xx xx, docs/09 §1). */
export function telephoneFictif(): string {
  return `+22501${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

export interface Banc {
  app: NestFastifyApplication;
  sms: JournalSms;
  associations: AssociationsService;
  owner: pg.Client;
  fermer(): Promise<void>;
}

export async function demarrer(): Promise<Banc> {
  const app = await creerApplication({ logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  return {
    app,
    sms: app.get<JournalSms>(FOURNISSEUR_SMS),
    associations: app.get(AssociationsService),
    owner,
    async fermer() {
      await owner.end();
      await app.close();
    },
  };
}

type Methode = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function appeler(
  b: Banc,
  methode: Methode,
  url: string,
  options: { jeton?: string; corps?: unknown; entetes?: Record<string, string> } = {},
) {
  return b.app.inject({
    method: methode,
    url,
    headers: {
      ...(options.jeton ? { authorization: `Bearer ${options.jeton}` } : {}),
      ...options.entetes,
    },
    ...(options.corps !== undefined ? { payload: options.corps as object } : {}),
  });
}

/** OTP → mot de passe (avec consentements), comme à la première connexion (docs/04 §2.1). */
export async function activerCompte(b: Banc, telephone: string, motDePasse = MOT_DE_PASSE): Promise<void> {
  const d = await appeler(b, 'POST', '/v1/auth/otp/demander', { corps: { telephone, but: 'inscription' } });
  expect(d.statusCode).toBe(204);
  const code = b.sms.dernierCode(telephone);
  expect(code).toMatch(/^\d{6}$/);
  const v = await appeler(b, 'POST', '/v1/auth/otp/verifier', {
    corps: { telephone, code, but: 'inscription' },
  });
  expect(v.statusCode).toBe(200);
  const m = await appeler(b, 'POST', '/v1/auth/mot-de-passe', {
    corps: { jetonOtp: v.json().jetonOtp, motDePasse, accepteCgu: true, accepteTraitementDonnees: true },
  });
  expect(m.statusCode).toBe(204);
}

/** Connexion mobile (pas de TOTP sur mobile, docs/04 §1). */
export async function connecterMobile(b: Banc, telephone: string, motDePasse = MOT_DE_PASSE) {
  const r = await appeler(b, 'POST', '/v1/auth/connexion', {
    corps: { identifiant: telephone, motDePasse, canal: 'mobile' },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as {
    accessToken: string;
    refreshToken: string;
    expireDans: number;
    utilisateur: { id: string };
  };
}

/** Première connexion console d'un membre du bureau (activation TOTP, docs/04 §1) : jeton `can = console`. */
export async function connecterConsole(b: Banc, telephone: string, motDePasse = MOT_DE_PASSE) {
  const r = await appeler(b, 'POST', '/v1/auth/connexion', {
    corps: { identifiant: telephone, motDePasse, canal: 'console' },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().etape).toBe('totp_activation');
  const intermediaire = r.json().jetonIntermediaire as string;
  const act = await appeler(b, 'POST', '/v1/auth/totp/activation', { jeton: intermediaire });
  expect(act.statusCode, act.body).toBe(200);
  const conf = await appeler(b, 'POST', '/v1/auth/totp/confirmation', {
    jeton: intermediaire,
    corps: { code: codeTotp(act.json().secret as string) },
  });
  expect(conf.statusCode, conf.body).toBe(200);
  return conf.json().session.accessToken as string;
}

export function codeTotp(secretBase32: string, instantMs = Date.now()): string {
  return totp(decoderBase32(secretBase32), instantMs);
}

export function claims(jeton: string) {
  return decodeJwt(jeton) as Record<string, unknown>;
}

/** Invite une personne avec le rôle donné (par le président), active son compte et renvoie son jeton mobile. */
export async function jetonPourRole(b: Banc, jetonPresident: string, roleId: string): Promise<string> {
  const telephone = telephoneFictif();
  const r = await appeler(b, 'POST', '/v1/acces', {
    jeton: jetonPresident,
    corps: { telephone, nom: 'Testeur', prenoms: 'Rôle', roleId },
  });
  expect(r.statusCode, r.body).toBe(201);
  await activerCompte(b, telephone);
  return (await connecterMobile(b, telephone)).accessToken;
}

/** Corps multipart/form-data avec une seule partie fichier (logo, photo). */
export function multipart(contenu: Buffer, nomFichier: string, type: string, champ = 'fichier') {
  const frontiere = `----assoflow${randomUUID()}`;
  return {
    corps: Buffer.concat([
      Buffer.from(
        `--${frontiere}\r\nContent-Disposition: form-data; name="${champ}"; filename="${nomFichier}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      contenu,
      Buffer.from(`\r\n--${frontiere}--\r\n`),
    ]),
    entetes: { 'content-type': `multipart/form-data; boundary=${frontiere}` },
  };
}

/** Images minimales reconnues par leurs magic bytes. */
export const IMAGES = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 3)]),
};

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { decodeJwt } from 'jose';
import { randomInt } from 'node:crypto';
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

type Methode = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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

export function codeTotp(secretBase32: string, instantMs = Date.now()): string {
  return totp(decoderBase32(secretBase32), instantMs);
}

export function claims(jeton: string) {
  return decodeJwt(jeton) as Record<string, unknown>;
}

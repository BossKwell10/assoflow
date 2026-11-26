import { decodeJwt, SignJWT } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chargerConfig } from '../src/config.js';
import { SecretsService } from '../src/infra/secrets.js';
import { JetonsService } from '../src/modules/auth/jetons.service.js';

describe('jetons JWT EdDSA (docs/04 §3)', () => {
  const secrets = new SecretsService(chargerConfig({ NODE_ENV: 'test' }));
  const jetons = new JetonsService(secrets);

  it('access token console : 10 min, claims de docs/04 §3, sans permissions', async () => {
    const { jeton, expireDans } = await jetons.signerAcces({
      sub: 'u1',
      sid: 's1',
      aid: 'a1',
      can: 'console',
    });
    expect(expireDans).toBe(600);
    const c = decodeJwt(jeton);
    expect(c).toMatchObject({
      sub: 'u1',
      sid: 's1',
      aid: 'a1',
      can: 'console',
      iss: 'assoflow',
      aud: 'assoflow:api',
    });
    expect(c).not.toHaveProperty('permissions');
    expect(c.exp! - c.iat!).toBe(600);
    const v = await jetons.verifierBearer(jeton, false);
    expect(v).toEqual({
      type: 'acces',
      claims: expect.objectContaining({ sub: 'u1', aid: 'a1', can: 'console' }),
    });
  });

  it('access token mobile : 15 min', async () => {
    expect((await jetons.signerAcces({ sub: 'u', sid: 's', can: 'mobile' })).expireDans).toBe(900);
  });

  it('refuse un jeton intermédiaire là où il n’est pas accepté', async () => {
    const j = await jetons.signerIntermediaire({ sub: 'u', can: 'console', etp: 'totp_activation' });
    await expect(jetons.verifierBearer(j, false)).rejects.toMatchObject({ code: 'NON_AUTHENTIFIE' });
    await expect(jetons.verifierBearer(j, true)).resolves.toMatchObject({ type: 'intermediaire' });
  });

  it('refuse un jeton signé par une autre clé', async () => {
    const autre = generateKeyPairSync('ed25519').privateKey;
    const faux = await new SignJWT({ sid: 's', can: 'console' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('u')
      .setIssuer('assoflow')
      .setAudience('assoflow:api')
      .setExpirationTime('5m')
      .sign(autre);
    await expect(jetons.verifierBearer(faux, false)).rejects.toMatchObject({ code: 'NON_AUTHENTIFIE' });
  });

  it('jeton expiré → JETON_EXPIRE', async () => {
    const expire = await new SignJWT({ sid: 's', can: 'console' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('u')
      .setIssuer('assoflow')
      .setAudience('assoflow:api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secrets.clePriveeJwt);
    await expect(jetons.verifierBearer(expire, false)).rejects.toMatchObject({ code: 'JETON_EXPIRE' });
  });

  it('utilise les clés PEM configurées', async () => {
    const paire = generateKeyPairSync('ed25519');
    const config = chargerConfig({
      NODE_ENV: 'test',
      JWT_PRIVATE_KEY: paire.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      JWT_PUBLIC_KEY: paire.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const j = new JetonsService(new SecretsService(config));
    const { jeton } = await j.signerAcces({ sub: 'u', sid: 's', can: 'mobile' });
    await expect(j.verifierBearer(jeton, false)).resolves.toMatchObject({ type: 'acces' });
  });

  it('refuse de générer des clés éphémères en production', () => {
    expect(
      () => new SecretsService({ ...chargerConfig({ NODE_ENV: 'test' }), NODE_ENV: 'production' }),
    ).toThrow(/obligatoire en production/);
  });
});

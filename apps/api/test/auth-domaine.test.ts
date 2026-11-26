import { describe, expect, it } from 'vitest';
import { chiffrer, dechiffrer } from '../src/modules/auth/domain/chiffrement.js';
import {
  egalEnTempsConstant,
  empreinteJeton,
  genererCodeOtp,
  genererCodesSecours,
  hmacPoivre,
  normaliserCodeSecours,
} from '../src/modules/auth/domain/hachage.js';
import {
  decoderBase32,
  encoderBase32,
  hotp,
  pasCourant,
  totp,
  urlOtpauth,
  verifierTotp,
} from '../src/modules/auth/domain/totp.js';
import { calculerVerrouillage } from '../src/modules/auth/domain/verrouillage.js';
import { DUREES_SESSION, SessionsService } from '../src/modules/auth/sessions.service.js';
import { randomBytes } from 'node:crypto';

describe('TOTP RFC 6238 (RF-003)', () => {
  // Annexe B de la RFC 6238 (SHA-1, secret ASCII « 12345678901234567890 », 8 chiffres).
  const secret = Buffer.from('12345678901234567890');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('vecteur de test T=%i → %s', (t, attendu) => {
    expect(totp(secret, t * 1000, 8)).toBe(attendu);
  });

  it('HOTP RFC 4226, annexe D', () => {
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 9)).toBe('520489');
  });

  it('base32 aller-retour', () => {
    const s = randomBytes(20);
    expect(decoderBase32(encoderBase32(s)).equals(s)).toBe(true);
    expect(encoderBase32(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepte une dérive d’un pas et renvoie le pas accepté', () => {
    const maintenant = 1_800_000_000_000;
    const precedent = totp(secret, maintenant - 30_000);
    expect(verifierTotp(secret, precedent, { instantMs: maintenant })).toBe(pasCourant(maintenant) - 1);
    expect(verifierTotp(secret, totp(secret, maintenant - 90_000), { instantMs: maintenant })).toBeNull();
  });

  it('refuse le rejeu d’un pas déjà utilisé', () => {
    const maintenant = 1_800_000_000_000;
    const code = totp(secret, maintenant);
    const pas = verifierTotp(secret, code, { instantMs: maintenant });
    expect(pas).not.toBeNull();
    expect(verifierTotp(secret, code, { instantMs: maintenant, dernierPas: pas })).toBeNull();
  });

  it('refuse un code mal formé', () => {
    expect(verifierTotp(secret, '12a456')).toBeNull();
    expect(verifierTotp(secret, '1234567')).toBeNull();
  });

  it('URL otpauth pour le QR code', () => {
    const url = urlOtpauth(secret, '+2250100000001');
    expect(url).toMatch(/^otpauth:\/\/totp\/AssoFlow%3A%2B2250100000001\?/);
    expect(url).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('OTP et secrets hachés (RF-001)', () => {
  const poivre = Buffer.from('poivre-de-test-suffisamment-long');

  it('HMAC-SHA256 poivré : déterministe, dépend du poivre, ne contient pas le code', () => {
    const code = '123456';
    const h = hmacPoivre(`+2250100000001|inscription|${code}`, poivre);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);
    expect(hmacPoivre(`+2250100000001|inscription|${code}`, poivre)).toBe(h);
    expect(
      hmacPoivre(`+2250100000001|inscription|${code}`, Buffer.from('autre-poivre-de-test-long')),
    ).not.toBe(h);
  });

  it('comparaison à temps constant', () => {
    const a = hmacPoivre('a', poivre);
    expect(egalEnTempsConstant(a, a)).toBe(true);
    expect(egalEnTempsConstant(a, hmacPoivre('b', poivre))).toBe(false);
    expect(egalEnTempsConstant(a, '')).toBe(false);
  });

  it('code OTP à 6 chiffres', () => {
    for (let i = 0; i < 50; i++) expect(genererCodeOtp()).toMatch(/^\d{6}$/);
  });

  it('10 codes de secours distincts, normalisables', () => {
    const codes = genererCodesSecours();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(normaliserCodeSecours(codes[0]!.toUpperCase().replace('-', ' '))).toBe(codes[0]);
  });

  it('empreinte SHA-256 du refresh token', () => {
    expect(empreinteJeton('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('chiffrement AES-256-GCM des champs (docs/04 §8)', () => {
  const cle = randomBytes(32);
  it('aller-retour, IV aléatoire', () => {
    const clair = Buffer.from('secret totp');
    const a = chiffrer(clair, cle);
    expect(dechiffrer(a, cle).toString()).toBe('secret totp');
    expect(chiffrer(clair, cle).equals(a)).toBe(false);
  });
  it('refuse une donnée altérée ou une mauvaise clé', () => {
    const a = chiffrer(Buffer.from('x'), cle);
    a[a.length - 1] = a[a.length - 1]! ^ 1;
    expect(() => dechiffrer(a, cle)).toThrow();
    expect(() => dechiffrer(chiffrer(Buffer.from('x'), cle), randomBytes(32))).toThrow();
  });
});

describe('verrouillage progressif (RF-005)', () => {
  const t0 = new Date('2026-11-26T10:00:00Z');
  const minutes = (v: { jusqua: Date }, depuis = t0) => (v.jusqua.getTime() - depuis.getTime()) / 60_000;

  it('premier verrouillage : 15 min', () => {
    const v = calculerVerrouillage(t0, { nombre: 0, dernier: null });
    expect(minutes(v)).toBe(15);
    expect(v.nombre).toBe(1);
  });
  it('double à chaque verrouillage dans les 24 h', () => {
    expect(
      minutes(calculerVerrouillage(t0, { nombre: 1, dernier: new Date(t0.getTime() - 3_600_000) })),
    ).toBe(30);
    expect(
      minutes(calculerVerrouillage(t0, { nombre: 3, dernier: new Date(t0.getTime() - 3_600_000) })),
    ).toBe(120);
  });
  it('plafonné à 24 h', () => {
    expect(minutes(calculerVerrouillage(t0, { nombre: 12, dernier: t0 }))).toBe(24 * 60);
  });
  it('repart à 15 min après 24 h sans verrouillage', () => {
    const v = calculerVerrouillage(t0, { nombre: 5, dernier: new Date(t0.getTime() - 25 * 3_600_000) });
    expect(minutes(v)).toBe(15);
    expect(v.nombre).toBe(1);
  });
});

describe('expiration des refresh tokens à la rotation (RF-006, docs/04 §3)', () => {
  const t0 = new Date('2026-11-26T08:00:00Z');
  it('console : 30 min d’inactivité', () => {
    expect(SessionsService.expiration('console', t0).getTime() - t0.getTime()).toBe(
      DUREES_SESSION.inactiviteConsoleMs,
    );
  });
  it('console : jamais au-delà de 12 h après l’ouverture de la famille', () => {
    const maintenant = new Date(t0.getTime() + 11 * 3_600_000 + 50 * 60_000);
    expect(SessionsService.expiration('console', maintenant, t0).getTime()).toBe(
      t0.getTime() + 12 * 3_600_000,
    );
  });
  it('mobile : glissante 30 jours', () => {
    const maintenant = new Date(t0.getTime() + 40 * 24 * 3_600_000);
    expect(SessionsService.expiration('mobile', maintenant, t0).getTime() - maintenant.getTime()).toBe(
      30 * 24 * 3_600_000,
    );
  });
});

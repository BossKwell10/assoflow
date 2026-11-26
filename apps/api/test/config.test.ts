import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chargerConfig } from '../src/config.js';

describe('chargerConfig', () => {
  it('applique les valeurs par défaut', () => {
    const c = chargerConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.APP_ROLE).toBe('api');
  });

  it('lit les secrets *_FILE (Docker secrets)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
    const f = path.join(dir, 'db');
    writeFileSync(f, 'postgres://app@db/assoflow\n');
    expect(chargerConfig({ DATABASE_APP_URL_FILE: f }).DATABASE_APP_URL).toBe('postgres://app@db/assoflow');
  });

  it('ignore les variables _FILE étrangères à la configuration', () => {
    expect(() => chargerConfig({ PIP_CONFIG_FILE: '/inexistant/pip.conf' })).not.toThrow();
  });

  it('refuse une configuration invalide avec un message lisible', () => {
    expect(() => chargerConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('exige la base en production', () => {
    expect(() => chargerConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_APP_URL/);
  });
});

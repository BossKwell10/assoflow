import { describe, expect, it } from 'vitest';
import {
  CachePermissionsMemoire,
  CachePermissionsRedis,
  type CachePermissions,
} from '../src/infra/cache-permissions.js';

const acces = { accesId: 'x', roleCode: 'tresorier', permissions: ['membre.lire'] };

function suite(nom: string, fabrique: () => CachePermissions, fin?: (c: CachePermissions) => Promise<void>) {
  describe(nom, () => {
    it('lit ce qui est écrit, y compris l’absence d’accès (null)', async () => {
      const c = fabrique();
      const aid = crypto.randomUUID();
      expect(await c.lire(aid, 'u1')).toBeUndefined();
      await c.ecrire(aid, 'u1', acces);
      await c.ecrire(aid, 'u2', null);
      expect(await c.lire(aid, 'u1')).toEqual(acces);
      expect(await c.lire(aid, 'u2')).toBeNull();
      await fin?.(c);
    });

    it('invalide un utilisateur ou tout le tenant', async () => {
      const c = fabrique();
      const aid = crypto.randomUUID();
      const autre = crypto.randomUUID();
      await c.ecrire(aid, 'u1', acces);
      await c.ecrire(aid, 'u2', acces);
      await c.ecrire(autre, 'u1', acces);
      await c.invalider(aid, 'u1');
      expect(await c.lire(aid, 'u1')).toBeUndefined();
      expect(await c.lire(aid, 'u2')).toEqual(acces);
      await c.invalider(aid);
      expect(await c.lire(aid, 'u2')).toBeUndefined();
      expect(await c.lire(autre, 'u1')).toEqual(acces);
      await fin?.(c);
    });
  });
}

suite('cache des permissions en mémoire (docs/04 §3)', () => new CachePermissionsMemoire());

describe('cache mémoire : TTL', () => {
  it('expire après le TTL', async () => {
    const c = new CachePermissionsMemoire(10);
    await c.ecrire('a', 'u', acces);
    await new Promise((r) => setTimeout(r, 20));
    expect(await c.lire('a', 'u')).toBeUndefined();
  });
});

// Implémentation Redis : exécutée seulement si REDIS_URL est fourni.
describe.skipIf(!process.env.REDIS_URL)('Redis', () => {
  suite(
    'cache des permissions Redis',
    () => CachePermissionsRedis.depuisUrl(process.env.REDIS_URL!),
    async (c) => (c as CachePermissionsRedis).onModuleDestroy(),
  );
});

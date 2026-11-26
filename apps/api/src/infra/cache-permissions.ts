import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/** Accès effectif d'un utilisateur dans un tenant : rôle + délégations actives (docs/04 §3). */
export interface AccesEffectif {
  accesId: string;
  roleCode: string;
  permissions: string[];
}

/**
 * Cache des permissions, clé `perm:<aid>:<sub>`, TTL 60 s (docs/04 §3).
 * `null` en cache = aucun accès actif (mis en cache aussi, pour éviter de marteler la base).
 * Toute modification de rôle, d'accès ou de délégation appelle `invalider()`.
 */
export interface CachePermissions {
  lire(aid: string, sub: string): Promise<AccesEffectif | null | undefined>;
  ecrire(aid: string, sub: string, valeur: AccesEffectif | null): Promise<void>;
  /** Sans `sub` : invalide tous les utilisateurs du tenant (modification d'un rôle). */
  invalider(aid: string, sub?: string): Promise<void>;
}

export const CACHE_PERMISSIONS = Symbol('CACHE_PERMISSIONS');
export const TTL_PERMISSIONS_S = 60;

const cle = (aid: string, sub: string) => `perm:${aid}:${sub}`;

export class CachePermissionsMemoire implements CachePermissions {
  private readonly entrees = new Map<string, { valeur: AccesEffectif | null; expire: number }>();

  constructor(private readonly ttlMs = TTL_PERMISSIONS_S * 1000) {}

  async lire(aid: string, sub: string) {
    const e = this.entrees.get(cle(aid, sub));
    if (!e) return undefined;
    if (e.expire < Date.now()) {
      this.entrees.delete(cle(aid, sub));
      return undefined;
    }
    return e.valeur;
  }

  async ecrire(aid: string, sub: string, valeur: AccesEffectif | null) {
    this.entrees.set(cle(aid, sub), { valeur, expire: Date.now() + this.ttlMs });
  }

  async invalider(aid: string, sub?: string) {
    if (sub) {
      this.entrees.delete(cle(aid, sub));
      return;
    }
    for (const k of this.entrees.keys()) if (k.startsWith(`perm:${aid}:`)) this.entrees.delete(k);
  }
}

export class CachePermissionsRedis implements CachePermissions, OnModuleDestroy {
  private readonly logger = new Logger('CachePermissions');

  constructor(private readonly redis: Redis) {}

  static depuisUrl(url: string): CachePermissionsRedis {
    return new CachePermissionsRedis(new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 }));
  }

  async lire(aid: string, sub: string) {
    try {
      const brut = await this.redis.get(cle(aid, sub));
      return brut === null ? undefined : (JSON.parse(brut) as AccesEffectif | null);
    } catch (e) {
      // Cache indisponible : on relit la base (jamais d'autorisation par défaut).
      this.logger.warn(`Lecture du cache impossible : ${(e as Error).message}`);
      return undefined;
    }
  }

  async ecrire(aid: string, sub: string, valeur: AccesEffectif | null) {
    try {
      await this.redis.set(cle(aid, sub), JSON.stringify(valeur), 'EX', TTL_PERMISSIONS_S);
    } catch (e) {
      this.logger.warn(`Écriture du cache impossible : ${(e as Error).message}`);
    }
  }

  /** L'invalidation doit réussir : une erreur remonte (sinon un accès révoqué survivrait 60 s). */
  async invalider(aid: string, sub?: string) {
    if (sub) {
      await this.redis.del(cle(aid, sub));
      return;
    }
    let curseur = '0';
    do {
      const [suivant, cles] = await this.redis.scan(curseur, 'MATCH', `perm:${aid}:*`, 'COUNT', 500);
      if (cles.length > 0) await this.redis.del(...cles);
      curseur = suivant;
    } while (curseur !== '0');
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }
}

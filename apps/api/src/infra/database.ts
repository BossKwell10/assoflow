import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { CONFIG, type Config } from '../config.js';
import { contexteCourant, type ContexteRequete } from '../common/contexte.js';

export type Tx = pg.PoolClient;

/**
 * Accès PostgreSQL avec le rôle applicatif (sans BYPASSRLS).
 * Toute requête métier passe par `tx()`, qui pose le contexte RLS par `SET LOCAL`
 * (docs/01-architecture-technique.md §4).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool?: pg.Pool;

  constructor(@Inject(CONFIG) config: Config) {
    if (config.DATABASE_APP_URL) {
      this.pool = new pg.Pool({ connectionString: config.DATABASE_APP_URL, max: 10 });
    }
  }

  get configuree(): boolean {
    return this.pool !== undefined;
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Exécute `travail` dans une transaction portant le contexte tenant.
   * Sans contexte explicite, utilise celui de la requête courante.
   */
  async tx<T>(
    travail: (tx: Tx) => Promise<T>,
    contexte: ContexteRequete | undefined = contexteCourant(),
  ): Promise<T> {
    if (!this.pool) throw new Error('Base de données non configurée (DATABASE_APP_URL)');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.association_id', $1, true),
                set_config('app.user_id', $2, true),
                set_config('app.role_plateforme', $3, true)`,
        [contexte?.associationId ?? '', contexte?.userId ?? '', contexte?.rolePlateforme ?? ''],
      );
      const resultat = await travail(client);
      await client.query('COMMIT');
      return resultat;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

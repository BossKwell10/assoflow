import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargerConfig } from '../src/config.js';
import { DatabaseService } from '../src/infra/database.js';

/**
 * Isolation multi-tenant et écritures en ajout seul, sur une vraie base migrée (D-004, D-005).
 * Nécessite DATABASE_URL (propriétaire) et DATABASE_APP_URL (assoflow_app) ; sinon ignoré.
 */
const actif = Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL);

describe.skipIf(!actif)('RLS et ajout seul (intégration PostgreSQL)', () => {
  const A = randomUUID();
  const B = randomUUID();
  const user = randomUUID();
  let owner: pg.Client;
  let db: DatabaseService;

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
    await owner.query(
      `INSERT INTO associations (id, nom, village, region) VALUES ($1, 'Test A', 'Village A', 'Lagunes'), ($2, 'Test B', 'Village B', 'Bélier')`,
      [A, B],
    );
    await owner.query(
      `INSERT INTO users (id, telephone, nom, prenoms) VALUES ($1, $2, 'Test', 'Utilisateur')`,
      [user, `+22507${String(Date.now()).slice(-8)}`],
    );
    db = new DatabaseService(chargerConfig());
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
    await owner?.end();
  });

  const ctxA = () => ({ requestId: 't', associationId: A, userId: user });

  it('un tenant ne voit que ses propres données', async () => {
    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO comptes_tresorerie (association_id, type, libelle) VALUES ($1, 'caisse', 'Caisse')`,
        [A],
      );
    }, ctxA());
    const vusParB = await db.tx(
      async (tx) => (await tx.query('SELECT count(*)::int AS n FROM comptes_tresorerie')).rows[0].n,
      { requestId: 't', associationId: B },
    );
    expect(vusParB).toBe(0);
  });

  it("refuse l'écriture dans un autre tenant", async () => {
    await expect(
      db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO comptes_tresorerie (association_id, type, libelle) VALUES ($1, 'caisse', 'X')`,
          [B],
        );
      }, ctxA()),
    ).rejects.toThrow(/row-level security/);
  });

  it('sans contexte, aucune donnée tenant n’est visible', async () => {
    const n = await db.tx(
      async (tx) => (await tx.query('SELECT count(*)::int AS n FROM comptes_tresorerie')).rows[0].n,
      {
        requestId: 't',
      },
    );
    expect(n).toBe(0);
  });

  it('les mouvements de trésorerie sont en ajout seul', async () => {
    await expect(
      db.tx(async (tx) => {
        await tx.query('UPDATE mouvements SET montant = 1');
      }, ctxA()),
    ).rejects.toThrow(/permission denied/);
  });

  it('le journal d’audit est chaîné', async () => {
    const hashes = await db.tx(async (tx) => {
      for (const action of ['membre.cree', 'membre.modifie']) {
        await tx.query(
          `INSERT INTO audit_log (association_id, acteur_id, acteur_type, action, entite_type) VALUES ($1, $2, 'utilisateur', $3, 'membre')`,
          [A, user, action],
        );
      }
      return (await tx.query('SELECT hash_precedent, hash FROM audit_log ORDER BY id')).rows;
    }, ctxA());
    expect(hashes).toHaveLength(2);
    expect(hashes[1].hash_precedent).toBe(hashes[0].hash);
  });
});

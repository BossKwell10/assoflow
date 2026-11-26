// Applique les migrations SQL de packages/db/migrations dans l'ordre, une seule fois chacune.
// Usage : DATABASE_URL=postgres://owner@… node scripts/migrate.mjs
// Exécuté avec le rôle propriétaire (assoflow_owner), jamais avec assoflow_app.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dossier = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nom text PRIMARY KEY, sha256 text NOT NULL, appliquee_at timestamptz NOT NULL DEFAULT now())`);
  const deja = new Map(
    (await client.query('SELECT nom, sha256 FROM schema_migrations')).rows.map((r) => [r.nom, r.sha256]),
  );
  const fichiers = (await readdir(dossier)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of fichiers) {
    const sql = await readFile(path.join(dossier, f), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    if (deja.has(f)) {
      if (deja.get(f) !== sha)
        throw new Error(`Migration ${f} modifiée après application : créer une nouvelle migration`);
      continue;
    }
    console.log(`→ ${f}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (nom, sha256) VALUES ($1, $2)', [f, sha]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  console.log('Migrations à jour.');
} finally {
  await client.end();
}

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { chargerConfig } from '../src/config.js';
import { FilesService } from '../src/infra/files/files.js';

/** Files BullMQ réelles (mode `file`, docs/06 §2) : exige un Redis (`REDIS_URL`). */
describe.skipIf(!process.env.REDIS_URL)('files BullMQ (intégration Redis)', () => {
  const ouverts: FilesService[] = [];
  afterEach(async () => {
    await Promise.all(ouverts.splice(0).map((f) => f.onModuleDestroy()));
  });

  function files(role: 'api' | 'worker') {
    const f = new FilesService(
      chargerConfig({
        NODE_ENV: 'test',
        APP_ROLE: role,
        TACHES_EXECUTION: 'file',
        REDIS_URL: process.env.REDIS_URL,
      }),
    );
    ouverts.push(f);
    return f;
  }

  it('l’API met en file, seul le worker consomme ; planification posée une fois par nom', async () => {
    const recus: Record<string, unknown>[] = [];
    let fin!: () => void;
    const termine = new Promise<void>((r) => (fin = r));
    const api = files('api');
    const worker = files('worker');
    for (const f of [api, worker]) {
      f.traiter('rapports', async (_nom, donnees) => {
        recus.push(donnees);
        fin();
      });
      f.planifier({ nom: `test.planif.${randomUUID()}`, cron: '0 3 * * *', executer: async () => undefined });
    }
    await api.onApplicationBootstrap(); // rôle api : ne consomme rien
    await worker.onApplicationBootstrap();
    const id = randomUUID();
    await api.ajouter('rapports', 'test', { tacheId: id }, id);
    await termine;
    expect(recus).toEqual([{ tacheId: id }]);
  });
});

describe('configuration des tâches', () => {
  it('le mode file exige Redis ; défaut `processus` hors production', () => {
    expect(() => chargerConfig({ NODE_ENV: 'test', TACHES_EXECUTION: 'file' })).toThrow(/REDIS_URL/);
    expect(chargerConfig({ NODE_ENV: 'test' }).TACHES_EXECUTION).toBe('processus');
  });
});

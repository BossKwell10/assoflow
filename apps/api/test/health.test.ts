import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creerApplication } from '../src/bootstrap.js';

describe('santé', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await creerApplication({ logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app.close());

  it('GET /health/live répond ok avec un X-Request-Id', async () => {
    const r = await app.inject({ method: 'GET', url: '/health/live' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ statut: 'ok' });
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('reprend le X-Request-Id fourni', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(r.headers['x-request-id']).toBe('abc-123');
  });

  it('GET /health/ready indique l’état de PostgreSQL', async () => {
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect([200, 503]).toContain(r.statusCode);
    expect(r.json().dependances).toHaveProperty('postgres');
  });

  it('une route inconnue renvoie un Problem Details 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/inexistant' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json().code).toBe('INTROUVABLE');
  });
});

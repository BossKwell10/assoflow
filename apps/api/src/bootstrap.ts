import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module.js';
import { contexteStorage } from './common/contexte.js';

/** Crée l'application HTTP (utilisée par main.api.ts et par les tests). */
export async function creerApplication(options: { logger?: boolean } = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger:
      options.logger === false
        ? false
        : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    genReqId: (req: IncomingMessage) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    trustProxy: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: options.logger === false ? false : undefined,
  });
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (req, reply, done) => {
    void reply.header('x-request-id', req.id);
    contexteStorage.enterWith({ requestId: String(req.id), ip: req.ip });
    done();
  });
  app.enableShutdownHooks();
  return app;
}

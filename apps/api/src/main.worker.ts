import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// Worker : consommera les files BullMQ (docs/06-jobs-notifications.md). Socle uniquement au sprint 0.
const app = await NestFactory.createApplicationContext(AppModule);
app.enableShutdownHooks();
new Logger('Worker').log('Worker démarré (aucune file enregistrée pour le moment)');

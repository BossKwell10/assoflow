import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// Worker : consomme les files BullMQ et pose les planifications (docs/06-jobs-notifications.md, FilesService).
const app = await NestFactory.createApplicationContext(AppModule);
app.enableShutdownHooks();
new Logger('Worker').log('Worker démarré');

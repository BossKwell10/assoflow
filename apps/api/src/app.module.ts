import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CONFIG, chargerConfig } from './config.js';
import { ProblemeFilter } from './common/probleme.filter.js';
import { DatabaseService } from './infra/database.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => chargerConfig() },
    DatabaseService,
    { provide: APP_FILTER, useClass: ProblemeFilter },
  ],
  exports: [CONFIG, DatabaseService],
})
export class AppModule {}

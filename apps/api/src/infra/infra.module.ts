import { Global, Logger, Module } from '@nestjs/common';
import { PermissionsService } from '../common/auth/permissions.service.js';
import { CONFIG, chargerConfig, type Config } from '../config.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { CACHE_PERMISSIONS, CachePermissionsMemoire, CachePermissionsRedis } from './cache-permissions.js';
import { DatabaseService } from './database.js';
import { IdempotenceService } from './idempotence.service.js';
import { SecretsService } from './secrets.js';
import { FOURNISSEUR_SMS } from './sms/fournisseur-sms.js';
import { JournalSms } from './sms/journal-sms.js';

/** Services transverses (configuration, base, secrets, cache, SMS, audit, permissions). */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => chargerConfig() },
    DatabaseService,
    SecretsService,
    {
      provide: CACHE_PERMISSIONS,
      inject: [CONFIG],
      useFactory: (config: Config) => {
        if (config.REDIS_URL) return CachePermissionsRedis.depuisUrl(config.REDIS_URL);
        if (config.NODE_ENV === 'production') {
          new Logger('CachePermissions').warn('REDIS_URL absent : cache mémoire local (une seule instance)');
        }
        return new CachePermissionsMemoire();
      },
    },
    {
      provide: FOURNISSEUR_SMS,
      inject: [CONFIG],
      useFactory: (config: Config) => {
        const premier = config.SMS_PROVIDERS.split(',')[0]?.trim();
        if (premier !== 'journal') throw new Error(`Fournisseur SMS non pris en charge : ${premier}`);
        return new JournalSms(config.NODE_ENV === 'test');
      },
    },
    AuditService,
    PermissionsService,
    IdempotenceService,
  ],
  exports: [
    CONFIG,
    DatabaseService,
    SecretsService,
    CACHE_PERMISSIONS,
    FOURNISSEUR_SMS,
    AuditService,
    PermissionsService,
    IdempotenceService,
  ],
})
export class InfraModule {}

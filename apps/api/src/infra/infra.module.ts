import { Global, Logger, Module } from '@nestjs/common';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PermissionsService } from '../common/auth/permissions.service.js';
import { CONFIG, chargerConfig, type Config } from '../config.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { CACHE_PERMISSIONS, CachePermissionsMemoire, CachePermissionsRedis } from './cache-permissions.js';
import { DatabaseService } from './database.js';
import { IdempotenceService } from './idempotence.service.js';
import { SecretsService } from './secrets.js';
import { FichiersController } from './stockage/fichiers.controller.js';
import { StockageLocal } from './stockage/stockage-local.js';
import { STOCKAGE_OBJETS } from './stockage/stockage-objets.js';
import { StockageS3 } from './stockage/stockage-s3.js';
import { FOURNISSEUR_SMS } from './sms/fournisseur-sms.js';
import { creerRouteurSms } from './sms/fabrique-sms.js';

/** Services transverses (configuration, base, secrets, cache, SMS, stockage, audit, permissions). */
@Global()
@Module({
  controllers: [FichiersController],
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
      inject: [CONFIG, DatabaseService],
      useFactory: (config: Config, db: DatabaseService) => creerRouteurSms(config, db),
    },
    {
      provide: STOCKAGE_OBJETS,
      inject: [CONFIG],
      useFactory: (config: Config) => {
        if (config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET_KEY) {
          return new StockageS3({
            endpoint: config.S3_ENDPOINT,
            region: config.S3_REGION,
            bucket: config.S3_BUCKET,
            accessKeyId: config.S3_ACCESS_KEY,
            secretAccessKey: config.S3_SECRET_KEY,
            forcePathStyle: config.S3_FORCE_PATH_STYLE,
          });
        }
        const dossier = config.STOCKAGE_LOCAL_DIR ?? path.join(tmpdir(), 'assoflow-stockage');
        if (config.NODE_ENV !== 'test') {
          new Logger('Stockage').warn(
            `S3 non configuré : stockage local dans ${dossier} (jamais en production)`,
          );
        }
        return new StockageLocal(dossier, config.PUBLIC_BASE_URL);
      },
    },
    AuditService,
    PermissionsService,
    IdempotenceService,
  ],
  exports: [
    STOCKAGE_OBJETS,
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

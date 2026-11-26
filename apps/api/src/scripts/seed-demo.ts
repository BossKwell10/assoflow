import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { masquerTelephone } from '@assoflow/contracts';
import { AppModule } from '../app.module.js';
import { CONFIG, type Config } from '../config.js';
import { DatabaseService } from '../infra/database.js';
import { AssociationsService } from '../modules/associations/associations.service.js';
import { ComptesService } from '../modules/auth/comptes.service.js';

/**
 * Jeu de démonstration minimal (docs/09 §1, données fictives uniquement — D-002) :
 * une association et son président (+225 01 00 00 00 01). Idempotent ; refusé en production.
 * Mot de passe du président : SEED_MOT_DE_PASSE, sinon « Demo-AssoFlow-2026 ». Le TOTP sera demandé
 * à la première connexion console.
 */
const TELEPHONE_PRESIDENT = '+2250100000001';
const logger = new Logger('seed:demo');

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
try {
  const config = app.get<Config>(CONFIG);
  if (config.NODE_ENV === 'production') throw new Error('seed:demo est interdit en production (D-002)');
  const db = app.get(DatabaseService);
  const existant = await db.tx(
    async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM users WHERE telephone = $1`, [TELEPHONE_PRESIDENT]))
        .rows[0],
    { requestId: 'seed-demo' },
  );
  const dejaPresident =
    existant &&
    (await db.tx(
      async (tx) => (await tx.query(`SELECT 1 FROM app_mes_acces() WHERE role_code = 'president'`)).rowCount,
      { requestId: 'seed-demo', userId: existant.id },
    ));
  if (dejaPresident) {
    logger.log('Association de démonstration déjà présente : rien à faire.');
  } else {
    const a = await app.get(AssociationsService).creer({
      nom: 'Mutuelle de développement de Kossou-Démo',
      sigle: 'MDKD',
      type: 'mutuelle_developpement',
      village: 'Kossou',
      region: 'Bélier',
      president: { telephone: TELEPHONE_PRESIDENT, nom: 'Démo', prenoms: 'Président' },
    });
    await db.tx(
      (tx) =>
        app
          .get(ComptesService)
          .initialiserPourDemo(tx, a.presidentUserId, process.env.SEED_MOT_DE_PASSE ?? 'Demo-AssoFlow-2026'),
      {
        requestId: 'seed-demo',
        userId: a.presidentUserId,
      },
    );
    logger.log(`Association ${a.associationId} créée ; président ${masquerTelephone(TELEPHONE_PRESIDENT)}.`);
  }
} finally {
  await app.close();
}

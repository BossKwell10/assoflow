import { Logger } from '@nestjs/common';
import type { Config } from '../../config.js';
import type { DatabaseService } from '../database.js';
import { AgregateurHttpSms } from './agregateur-http.js';
import type { FournisseurSms } from './fournisseur-sms.js';
import { JournalSms } from './journal-sms.js';
import { RouteurSms } from './routeur-sms.js';
import { SimulateurSms } from './simulateur-sms.js';

const prefixes = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

/** Fournisseurs de `SMS_PROVIDERS` (ordre de préférence) derrière le routeur (bascule, disjoncteur). */
export function creerRouteurSms(config: Config, db: DatabaseService): RouteurSms {
  const modeTest = config.NODE_ENV === 'test';
  const fournisseurs: FournisseurSms[] = config.SMS_PROVIDERS.split(',').map((brut) => {
    const code = brut.trim();
    switch (code) {
      case 'agregateur_a':
        return new AgregateurHttpSms({
          code,
          url: config.SMS_AGREGATEUR_A_URL!,
          jeton: config.SMS_AGREGATEUR_A_TOKEN!,
          expediteur: config.SMS_AGREGATEUR_A_EXPEDITEUR,
          secretWebhook: config.SMS_AGREGATEUR_A_WEBHOOK_SECRET,
          prefixes: prefixes(config.SMS_AGREGATEUR_A_PREFIXES),
        });
      case 'agregateur_b':
        return new AgregateurHttpSms({
          code,
          url: config.SMS_AGREGATEUR_B_URL!,
          jeton: config.SMS_AGREGATEUR_B_TOKEN!,
          expediteur: config.SMS_AGREGATEUR_B_EXPEDITEUR,
          secretWebhook: config.SMS_AGREGATEUR_B_WEBHOOK_SECRET,
          prefixes: prefixes(config.SMS_AGREGATEUR_B_PREFIXES),
        });
      case 'simulateur':
      case 'simulateur_b':
        return new SimulateurSms(
          code,
          modeTest,
          config.SMS_SIMULATEUR_WEBHOOK_SECRET,
          config.SMS_SIMULATEUR_PANNE,
        );
      default:
        return new JournalSms(modeTest);
    }
  });
  if (config.NODE_ENV === 'production' && fournisseurs.every((f) => !(f instanceof AgregateurHttpSms))) {
    new Logger('SMS').warn(
      `Aucun agrégateur réel configuré (SMS_PROVIDERS=${config.SMS_PROVIDERS}) : aucun SMS ne part`,
    );
  }
  const statistiques = db.configuree
    ? (code: string) =>
        db.tx(
          async (tx) => {
            const r = await tx.query<{ envoyes: string; remis: string }>(
              `SELECT envoyes, remis FROM app_remise_fournisseur_sms($1)`,
              [code],
            );
            return { envoyes: Number(r.rows[0]?.envoyes ?? 0), remis: Number(r.rows[0]?.remis ?? 0) };
          },
          { requestId: 'sms-disjoncteur' },
        )
    : undefined;
  return new RouteurSms(fournisseurs, statistiques, modeTest);
}

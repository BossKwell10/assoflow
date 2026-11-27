import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { CONFIG, type Config } from '../config.js';

/**
 * Secrets cryptographiques de l'API (docs/01 §6) : clés de signature des jetons, clé de chiffrement
 * des champs, poivre des OTP. En développement et en test, une valeur éphémère est générée au démarrage
 * si la variable est absente (avec un avertissement) ; en production, `chargerConfig()` refuse de démarrer.
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger('Secrets');
  readonly clePriveeJwt: KeyObject;
  readonly clePubliqueJwt: KeyObject;
  readonly cleChiffrement: Buffer;
  readonly poivreOtp: Buffer;
  /** Clé HMAC des QR codes de carte de membre (RG-MBR-008). */
  readonly cleQr: Buffer;

  constructor(@Inject(CONFIG) config: Config) {
    if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY) {
      this.clePriveeJwt = createPrivateKey(config.JWT_PRIVATE_KEY);
      this.clePubliqueJwt = createPublicKey(config.JWT_PUBLIC_KEY);
      if (this.clePriveeJwt.asymmetricKeyType !== 'ed25519') {
        throw new Error('Configuration invalide — JWT_PRIVATE_KEY doit être une clé Ed25519');
      }
    } else {
      this.exigerHorsProduction(config, 'JWT_PRIVATE_KEY/JWT_PUBLIC_KEY');
      const paire = generateKeyPairSync('ed25519');
      this.clePriveeJwt = paire.privateKey;
      this.clePubliqueJwt = paire.publicKey;
    }
    if (config.FIELD_ENCRYPTION_KEY) {
      this.cleChiffrement = Buffer.from(config.FIELD_ENCRYPTION_KEY, 'base64');
    } else {
      this.exigerHorsProduction(config, 'FIELD_ENCRYPTION_KEY');
      this.cleChiffrement = randomBytes(32);
    }
    if (config.OTP_PEPPER) {
      this.poivreOtp = Buffer.from(config.OTP_PEPPER, 'utf8');
    } else {
      this.exigerHorsProduction(config, 'OTP_PEPPER');
      this.poivreOtp = randomBytes(32);
    }
    if (config.QR_SIGNING_KEY) {
      this.cleQr = Buffer.from(config.QR_SIGNING_KEY, 'utf8');
    } else {
      this.exigerHorsProduction(config, 'QR_SIGNING_KEY');
      this.cleQr = randomBytes(32);
    }
  }

  private exigerHorsProduction(config: Config, nom: string): void {
    if (config.NODE_ENV === 'production') {
      throw new Error(`Configuration invalide — ${nom} obligatoire en production`);
    }
    this.logger.warn(
      `${nom} absent : valeur éphémère générée (invalide après redémarrage, jamais en production)`,
    );
  }
}

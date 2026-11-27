import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Configuration validée au démarrage (docs/01-architecture-technique.md §6).
 * Toute variable `X_FILE` est lue depuis le fichier (Docker secrets) et remplace `X`.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  CONSOLE_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_APP_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  /** Clés Ed25519 au format PEM (PKCS#8 / SPKI) pour signer les jetons d'accès (docs/04 §3). */
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),
  /** Clé AES-256 (32 octets en base64) pour les champs chiffrés (TOTP). */
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'clé AES-256 de 32 octets en base64 attendue')
    .optional(),
  /** Poivre des HMAC d'OTP et de codes de secours (au moins 16 caractères). */
  OTP_PEPPER: z.string().min(16).optional(),
  /**
   * Fournisseurs SMS par ordre de préférence (docs/06 §4.1) : `agregateur_a`, `agregateur_b` (HTTP),
   * `simulateur`, `simulateur_b` (recette, sans envoi réel), `journal` (logs, développement et tests).
   */
  SMS_PROVIDERS: z.string().default('journal'),
  SMS_AGREGATEUR_A_URL: z.url().optional(),
  SMS_AGREGATEUR_A_TOKEN: z.string().min(1).optional(),
  SMS_AGREGATEUR_A_EXPEDITEUR: z.string().min(1).max(11).default('AssoFlow'),
  SMS_AGREGATEUR_A_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Préfixes E.164 servis, séparés par des virgules (vide = tous). */
  SMS_AGREGATEUR_A_PREFIXES: z.string().optional(),
  SMS_AGREGATEUR_B_URL: z.url().optional(),
  SMS_AGREGATEUR_B_TOKEN: z.string().min(1).optional(),
  SMS_AGREGATEUR_B_EXPEDITEUR: z.string().min(1).max(11).default('AssoFlow'),
  SMS_AGREGATEUR_B_WEBHOOK_SECRET: z.string().min(16).optional(),
  SMS_AGREGATEUR_B_PREFIXES: z.string().optional(),
  /** Simulateur : secret des accusés de remise simulés et panne simulée (`transitoire`, `definitive`). */
  SMS_SIMULATEUR_WEBHOOK_SECRET: z.string().min(16).optional(),
  SMS_SIMULATEUR_PANNE: z.enum(['aucune', 'transitoire', 'definitive']).default('aucune'),
  /** Stockage objet S3 compatible (docs/01 §6). Sans `S3_BUCKET` : stockage local sur disque (hors production). */
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('ci-abj'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  /** Adressage « chemin » (MinIO, Ceph) plutôt que sous-domaine. */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Dossier du stockage local (développement, tests) ; défaut : dossier temporaire du système. */
  STOCKAGE_LOCAL_DIR: z.string().min(1).optional(),
  /**
   * Exécution des tâches asynchrones (docs/06) : `file` = files BullMQ consommées par le worker (production) ;
   * `processus` = exécution dans le processus API, sans Redis (développement, tests). Défaut : `file` en
   * production, `processus` ailleurs.
   */
  TACHES_EXECUTION: z.enum(['file', 'processus']).optional(),
  /** Clé HMAC des QR codes de carte de membre (RG-MBR-008), 32 caractères minimum. */
  QR_SIGNING_KEY: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MIN_APP_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default('1.0.0'),
});

export type Config = z.infer<typeof schema>;

export function chargerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const brut: Record<string, string | undefined> = { ...env };
  // Seules les clés connues du schéma acceptent une variante _FILE (pas PIP_CONFIG_FILE, etc.).
  for (const cle of Object.keys(schema.shape)) {
    const fichier = env[`${cle}_FILE`];
    if (fichier) brut[cle] = readFileSync(fichier, 'utf8').trim();
  }
  const resultat = schema.safeParse(brut);
  if (!resultat.success) {
    const details = resultat.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join('; ');
    throw new Error(`Configuration invalide — ${details}`);
  }
  const config = resultat.data;
  if (config.NODE_ENV === 'production') {
    const manquantes = (
      [
        'DATABASE_APP_URL',
        'JWT_PRIVATE_KEY',
        'JWT_PUBLIC_KEY',
        'FIELD_ENCRYPTION_KEY',
        'OTP_PEPPER',
        'S3_BUCKET',
        'S3_ACCESS_KEY',
        'S3_SECRET_KEY',
        'QR_SIGNING_KEY',
        'REDIS_URL',
      ] as const
    ).filter((cle) => !config[cle]);
    if (manquantes.length > 0) {
      throw new Error(`Configuration invalide — ${manquantes.join(', ')} obligatoire(s) en production`);
    }
  }
  const fournisseurs = config.SMS_PROVIDERS.split(',').map((c) => c.trim());
  for (const code of fournisseurs) {
    if (!CODES_SMS.includes(code as (typeof CODES_SMS)[number])) {
      throw new Error(`Configuration invalide — fournisseur SMS inconnu : ${code}`);
    }
    const prefixe =
      code === 'agregateur_a' ? 'SMS_AGREGATEUR_A' : code === 'agregateur_b' ? 'SMS_AGREGATEUR_B' : null;
    if (prefixe && (!config[`${prefixe}_URL`] || !config[`${prefixe}_TOKEN`])) {
      throw new Error(
        `Configuration invalide — ${prefixe}_URL et ${prefixe}_TOKEN obligatoires pour ${code}`,
      );
    }
  }
  if (Boolean(config.JWT_PRIVATE_KEY) !== Boolean(config.JWT_PUBLIC_KEY)) {
    throw new Error('Configuration invalide — JWT_PRIVATE_KEY et JWT_PUBLIC_KEY vont de pair');
  }
  config.TACHES_EXECUTION ??= config.NODE_ENV === 'production' ? 'file' : 'processus';
  if (config.TACHES_EXECUTION === 'file' && !config.REDIS_URL) {
    throw new Error('Configuration invalide — TACHES_EXECUTION=file exige REDIS_URL');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');

/** Codes de fournisseurs SMS reconnus dans `SMS_PROVIDERS`. */
export const CODES_SMS = ['agregateur_a', 'agregateur_b', 'simulateur', 'simulateur_b', 'journal'] as const;

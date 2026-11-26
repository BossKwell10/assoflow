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
  /** Fournisseurs SMS par ordre de préférence. Sprint 1 : `journal` uniquement (docs/06 §4.1). */
  SMS_PROVIDERS: z.string().default('journal'),
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
      ['DATABASE_APP_URL', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'FIELD_ENCRYPTION_KEY', 'OTP_PEPPER'] as const
    ).filter((cle) => !config[cle]);
    if (manquantes.length > 0) {
      throw new Error(`Configuration invalide — ${manquantes.join(', ')} obligatoire(s) en production`);
    }
  }
  if (Boolean(config.JWT_PRIVATE_KEY) !== Boolean(config.JWT_PUBLIC_KEY)) {
    throw new Error('Configuration invalide — JWT_PRIVATE_KEY et JWT_PUBLIC_KEY vont de pair');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');

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
  if (config.NODE_ENV === 'production' && !config.DATABASE_APP_URL) {
    throw new Error('Configuration invalide — DATABASE_APP_URL est obligatoire en production');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');

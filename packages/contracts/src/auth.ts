import { z } from 'zod';
import { telephoneSchema } from './telephone.js';

/** Schémas des requêtes d'authentification (docs/openapi.yaml, tag « Authentification »). */

export const BUTS_OTP = ['inscription', 'connexion', 'reinitialisation', 'confirmation_appareil'] as const;
export type ButOtp = (typeof BUTS_OTP)[number];

export const CANAUX = ['console', 'mobile'] as const;
export type Canal = (typeof CANAUX)[number];

/** Version des textes CGU / traitement des données acceptés à la définition du mot de passe (RF-SUP-054). */
export const VERSION_CGU = '2026-11';

/** En-tête anti-CSRF exigé par `POST /v1/auth/refresh` côté console (docs/04 §10). */
export const ENTETE_CONSOLE = { nom: 'x-requested-with', valeur: 'assoflow-console' } as const;

export const otpDemanderSchema = z.object({
  telephone: telephoneSchema,
  but: z.enum(BUTS_OTP),
});

export const otpVerifierSchema = z.object({
  telephone: telephoneSchema,
  code: z.string().regex(/^[0-9]{6}$/, 'Code à 6 chiffres attendu'),
  but: z.enum(BUTS_OTP),
});

export const motDePasseSchema = z.object({
  jetonOtp: z.string().min(1),
  motDePasse: z.string().min(1).max(256),
  accepteCgu: z.boolean().optional(),
  accepteTraitementDonnees: z.boolean().optional(),
  canal: z.enum(CANAUX).optional(),
});

export const connexionSchema = z.object({
  identifiant: z.string().trim().min(1).max(254),
  motDePasse: z.string().min(1).max(256),
  canal: z.enum(CANAUX),
});

export const totpSchema = z.object({
  jetonIntermediaire: z.string().min(1),
  code: z.string().trim().min(6).max(20),
});

export const totpConfirmationSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, 'Code à 6 chiffres attendu'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const contexteSchema = z.object({
  associationId: z.uuid(),
});

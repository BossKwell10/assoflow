import { z } from 'zod';
import { telephoneSchema } from './telephone.js';

/** Schémas des requêtes du tag « Accès et rôles » (docs/openapi.yaml). */

const date = z.iso.date();

export const accesInvitationSchema = z
  .object({
    telephone: telephoneSchema,
    nom: z.string().trim().min(1).max(100),
    prenoms: z.string().trim().min(1).max(150),
    roleId: z.uuid(),
    membreId: z.uuid().optional(),
    mandatDebut: date.optional(),
    mandatFin: date.optional(),
  })
  .refine((v) => !v.mandatDebut || !v.mandatFin || v.mandatFin >= v.mandatDebut, {
    message: 'La fin de mandat doit suivre le début',
    path: ['mandatFin'],
  });

export const accesMajSchema = z
  .object({
    roleId: z.uuid().optional(),
    mandatDebut: date.nullable().optional(),
    mandatFin: date.nullable().optional(),
  })
  .refine((v) => !v.mandatDebut || !v.mandatFin || v.mandatFin >= v.mandatDebut, {
    message: 'La fin de mandat doit suivre le début',
    path: ['mandatFin'],
  });

export const motifSchema = z.object({ motif: z.string().trim().min(3).max(500) });

export const roleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Code en minuscules, chiffres et _ (2 à 40 caractères)'),
  libelle: z.string().trim().min(1).max(100),
  permissions: z.array(z.string()).max(100),
});

export const roleMajSchema = roleSchema.partial();

import { z } from 'zod';
import { montantSchema } from './montant.js';
import { telephoneSchema } from './telephone.js';
import { UUID_V7 } from './uuid.js';

/** Schémas des requêtes des tags « Association » et « Membres » (docs/openapi.yaml). */

const date = z.iso.date();

/** Texte libre facultatif : chaîne vide → `null`. */
const texte = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const requis = (max: number) => z.string().trim().min(1, 'Champ obligatoire').max(max);

const email = z
  .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.email().max(254).nullable())
  .optional();

export const STATUTS_ADHESION = ['actif', 'dormant', 'honoraire', 'bienfaiteur'] as const;
export const ETATS_MEMBRE = ['actif', 'suspendu', 'desactive'] as const;
export const CANAUX_PREFERES = ['sms', 'whatsapp', 'push', 'aucun'] as const;
export const LIENS_AYANT_DROIT = ['conjoint', 'enfant', 'parent', 'autre'] as const;
export const NATURES_DEPENSE = ['fonctionnement', 'projet', 'aide_sociale', 'autre'] as const;
export const TYPES_ASSOCIATION = [
  'association',
  'mutuelle_developpement',
  'mutuelle_sociale',
  'autre',
] as const;

const champsMembre = {
  nom: requis(100),
  prenoms: requis(150),
  sexe: z.enum(['F', 'M']).nullable().optional(),
  dateNaissance: date.nullable().optional(),
  telephone: telephoneSchema.nullable().optional(),
  telephoneWhatsapp: z.boolean().optional(),
  email,
  villageOrigine: texte(100),
  lieuResidence: texte(100),
  paysResidence: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'Code pays ISO 3166-1 alpha-2 attendu')
    .transform((v) => v.toUpperCase())
    .optional(),
  categorieId: z.uuid().nullable().optional(),
  familleId: z.uuid().nullable().optional(),
  statutAdhesion: z.enum(STATUTS_ADHESION).optional(),
  canalPrefere: z.enum(CANAUX_PREFERES).optional(),
  notes: texte(2000),
};

/** `POST /membres` (MembreCreation) : id UUIDv7 client, consentement obligatoire (docs/08 A4). */
export const membreCreationSchema = z.object({
  id: z.string().regex(UUID_V7, 'UUIDv7 attendu'),
  ...champsMembre,
  dateAdhesion: date.optional(),
  consentement: z.object({
    traitementDonnees: z.literal(true, 'Le consentement au traitement des données est obligatoire'),
    canal: z.enum(['console', 'papier', 'mobile']),
  }),
  confirmationDoublon: z.boolean().optional(),
});
export type MembreCreation = z.infer<typeof membreCreationSchema>;

/** `PATCH /membres/{id}` (MembreMaj) : champs envoyés seulement. */
export const membreMajSchema = z.object(champsMembre).partial();
export type MembreMaj = z.infer<typeof membreMajSchema>;

export const doublonDecisionSchema = z.object({ decision: z.literal('pas_doublon') });

export const familleSchema = z.object({
  id: z.uuid().optional(),
  nom: requis(100),
  chefFamilleId: z.uuid().nullable().optional(),
  villageOrigine: texte(100),
});
export const familleMajSchema = familleSchema.omit({ id: true }).partial();

export const ayantDroitSchema = z.object({
  id: z.uuid().optional(),
  nom: requis(100),
  prenoms: requis(150),
  lien: z.enum(LIENS_AYANT_DROIT),
  dateNaissance: date.nullable().optional(),
});
export const ayantDroitMajSchema = ayantDroitSchema.omit({ id: true }).partial();

export const categorieMembreSchema = z.object({
  libelle: requis(100),
  description: texte(500),
  actif: z.boolean().optional(),
});
export const categorieMembreMajSchema = categorieMembreSchema.partial();

export const categorieDepenseSchema = z.object({
  nature: z.enum(NATURES_DEPENSE),
  libelle: requis(100),
  actif: z.boolean().optional(),
});
export const categorieDepenseMajSchema = categorieDepenseSchema.partial();

export const exerciceSchema = z
  .object({ libelle: requis(100), dateDebut: date, dateFin: date })
  .refine((v) => v.dateFin > v.dateDebut, {
    message: 'La date de fin doit suivre la date de début',
    path: ['dateFin'],
  });

/** `PATCH /association` (AssociationMaj). La devise (RG-ASS-002) et le statut ne sont pas modifiables. */
export const associationMajSchema = z
  .object({
    nom: requis(150),
    sigle: texte(30),
    type: z.enum(TYPES_ASSOCIATION),
    village: requis(100),
    sousPrefecture: texte(100),
    region: requis(100),
    dateCreation: date.nullable(),
    recepisseNumero: texte(100),
    recepisseDate: date.nullable(),
    prefectureDepot: texte(100),
    telephone: telephoneSchema.nullable(),
    email,
    moisDebutExercice: z.number().int().min(1).max(12),
    seuilDoubleValidation: montantSchema,
    seuilAlerteSolde: montantSchema,
    joursRetardDormant: z.number().int().min(1).max(3650),
    journalPublicActif: z.boolean(),
  })
  .partial();
export type AssociationMaj = z.infer<typeof associationMajSchema>;

/**
 * `POST /membres/import/{tacheId}/confirmer` : le bureau atteste avoir recueilli le consentement des membres
 * importés (RF-SUP-054, enregistré avec le canal `papier`).
 */
export const importConfirmationSchema = z.object({
  inclureDoublons: z.boolean().optional(),
  attestationConsentement: z.literal(
    true,
    'Attestez que les membres importés ont donné leur accord pour le traitement de leurs données',
  ),
});
export type ImportConfirmation = z.infer<typeof importConfirmationSchema>;

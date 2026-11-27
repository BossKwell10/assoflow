import { z } from 'zod';
import { montantSchema, PAIEMENT_CONFIRMATION_AU_DELA, PAIEMENT_MAX } from './montant.js';

/** Schémas des paiements (E4-05 à E4-08, RG-COT-020 à 041) et des comptes de trésorerie (RG-COT-032). */

export const MODES_PAIEMENT = ['especes', 'mobile_money', 'virement', 'cheque'] as const;
export type ModePaiement = (typeof MODES_PAIEMENT)[number];
export const OPERATEURS_MM = ['orange', 'mtn', 'moov', 'wave', 'autre'] as const;
export type OperateurMm = (typeof OPERATEURS_MM)[number];
export const TYPES_COMPTE = ['caisse', 'banque', 'mobile_money'] as const;
export type TypeCompte = (typeof TYPES_COMPTE)[number];

export const LIBELLES_MODES_PAIEMENT: Record<ModePaiement, string> = {
  especes: 'Espèces',
  mobile_money: 'Mobile money',
  virement: 'Virement',
  cheque: 'Chèque',
};

export const LIBELLES_OPERATEURS_MM: Record<OperateurMm, string> = {
  orange: 'Orange Money',
  mtn: 'MTN MoMo',
  moov: 'Moov Money',
  wave: 'Wave',
  autre: 'Autre opérateur',
};

/**
 * RG-COT-032 : type de compte proposé par défaut pour un mode de paiement (`Caisse` pour les espèces,
 * compte mobile money ou banque sinon). Le serveur n'impose pas le type : le compte reste au choix du saisisseur.
 */
export const TYPE_COMPTE_PAR_MODE: Record<ModePaiement, TypeCompte> = {
  especes: 'caisse',
  mobile_money: 'mobile_money',
  virement: 'banque',
  cheque: 'banque',
};

/** Numéro provisoire attribué hors ligne (RG-NUM-002) : `<préfixe d'appareil>-<compteur>` (ex. `T02-000145`). */
export const NUMERO_PROVISOIRE = /^[A-Z]\d{2,3}-\d{1,9}$/;

const texteOptionnel = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/**
 * `POST /paiements` (PaiementCreation). Exactement un de `membreId` ou `familleId` ; opérateur obligatoire en
 * mobile money (RG-COT-030) ; montant entier de 1 à 5 000 000 FCFA, confirmation explicite au-delà de 500 000
 * (RG-COT-031, vérifiée par le serveur avec le code `CONFIRMATION_REQUISE`).
 */
export const paiementCreationSchema = z
  .object({
    id: z.uuid(),
    membreId: z.uuid().nullable().optional(),
    familleId: z.uuid().nullable().optional(),
    campagneId: z.uuid().nullable().optional(),
    montant: montantSchema
      .min(1, 'Montant strictement positif')
      .max(PAIEMENT_MAX, 'Montant maximum : 5 000 000 FCFA'),
    mode: z.enum(MODES_PAIEMENT),
    operateurMm: z.enum(OPERATEURS_MM).nullable().optional(),
    referenceExterne: texteOptionnel(100),
    compteId: z.uuid(),
    datePaiement: z.iso.datetime({ offset: true }),
    numeroRecuProvisoire: z
      .string()
      .regex(NUMERO_PROVISOIRE, 'Numéro provisoire attendu : lettre, 2 ou 3 chiffres, tiret, compteur')
      .nullable()
      .optional(),
    confirmationMontantEleve: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (Boolean(p.membreId) === Boolean(p.familleId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['membreId'],
        message: 'Indiquez un membre ou une famille (un seul)',
      });
    }
    if (p.mode === 'mobile_money' && !p.operateurMm) {
      ctx.addIssue({
        code: 'custom',
        path: ['operateurMm'],
        message: 'Opérateur obligatoire en mobile money',
      });
    }
    if (p.mode !== 'mobile_money' && p.operateurMm) {
      ctx.addIssue({ code: 'custom', path: ['operateurMm'], message: 'Opérateur réservé au mobile money' });
    }
  });
export type PaiementCreation = z.infer<typeof paiementCreationSchema>;

/** RG-COT-031 : un montant au-delà de ce seuil exige `confirmationMontantEleve: true`. */
export function confirmationMontantRequise(montant: number): boolean {
  return montant > PAIEMENT_CONFIRMATION_AU_DELA;
}

/** `POST /comptes` (Compte) : compte de trésorerie (RF-043). Le solde est calculé, jamais saisi après création. */
export const compteCreationSchema = z.object({
  type: z.enum(TYPES_COMPTE),
  libelle: z.string().trim().min(1, 'Champ obligatoire').max(100),
  banqueOuOperateur: texteOptionnel(100),
  numeroCompte: texteOptionnel(50),
  soldeInitial: montantSchema.optional(),
  dateSoldeInitial: z.iso.date().optional(),
});
export type CompteCreation = z.infer<typeof compteCreationSchema>;

/** `POST /echeances/relancer` (écran A10). */
export const relanceSchema = z.object({ echeanceIds: z.array(z.uuid()).min(1).max(500) });

/** `POST /rapports` (DemandeRapport) : seul `export_cotisants` est disponible au sprint 4 (RF-039). */
export const TYPES_RAPPORT = [
  'rapport_financier',
  'rapport_moral',
  'export_membres',
  'export_cotisants',
  'export_audit',
  'export_association_complet',
] as const;
export const demandeRapportSchema = z.object({
  type: z.enum(TYPES_RAPPORT),
  format: z.enum(['pdf', 'xlsx', 'csv', 'zip']),
  parametres: z
    .object({
      debut: z.iso.date().optional(),
      fin: z.iso.date().optional(),
      exerciceId: z.uuid().optional(),
      campagneId: z.uuid().optional(),
    })
    .optional(),
});
export type DemandeRapport = z.infer<typeof demandeRapportSchema>;

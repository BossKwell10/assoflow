import { z } from 'zod';
import { montantSchema, PAIEMENT_MAX } from './montant.js';

/** Schémas du tag « Cotisations » (campagnes, échéances) et calcul des périodes (RG-COT-011). */

const date = z.iso.date();

export const PERIODICITES = ['unique', 'mensuelle', 'trimestrielle', 'semestrielle', 'annuelle'] as const;
export type Periodicite = (typeof PERIODICITES)[number];
export const TYPES_CAMPAGNE = ['ordinaire', 'exceptionnelle'] as const;
export const MOTIFS_CAMPAGNE = ['projet', 'deces', 'evenement', 'autre'] as const;
export const STATUTS_CAMPAGNE = ['brouillon', 'active', 'cloturee'] as const;
export const SITUATIONS_ECHEANCE = ['a_venir', 'partielle', 'payee', 'en_retard', 'exoneree'] as const;

/** Champs d'une campagne, sans contrôle croisé (le serveur revérifie après fusion lors d'un PATCH). */
const champsCampagne = {
  exerciceId: z.uuid(),
  libelle: z.string().trim().min(1, 'Champ obligatoire').max(150),
  type: z.enum(TYPES_CAMPAGNE),
  motif: z.enum(MOTIFS_CAMPAGNE).nullable().optional(),
  projetId: z.uuid().nullable().optional(),
  /** Montant par période (FCFA). */
  montant: montantSchema.min(1, 'Montant strictement positif').max(PAIEMENT_MAX),
  periodicite: z.enum(PERIODICITES),
  dateDebut: date,
  dateFin: date,
  jourEcheance: z.number().int().min(1).max(28).optional(),
  /** Catégories de membres ciblées ; vide = toutes (RG-COT-010). */
  categoriesCibles: z.array(z.uuid()).max(50).optional(),
};

/** Règles croisées d'une campagne complète (création, ou état fusionné d'une modification). */
export function verifierCampagne(
  c: { type: string; motif?: string | null; dateDebut: string; dateFin: string },
  ajouter: (champ: string, message: string) => void,
): void {
  if (c.dateFin < c.dateDebut) ajouter('dateFin', 'La date de fin doit suivre la date de début');
  if (c.type === 'exceptionnelle' && !c.motif) {
    ajouter('motif', 'Motif obligatoire pour une cotisation exceptionnelle (RF-037)');
  }
}

/** `POST /campagnes` : création en brouillon (RG-COT-001). */
export const campagneCreationSchema = z
  .object(champsCampagne)
  .superRefine((c, ctx) =>
    verifierCampagne(c, (champ, message) => ctx.addIssue({ code: 'custom', path: [champ], message })),
  );
export type CampagneCreation = z.infer<typeof campagneCreationSchema>;

/** `PATCH /campagnes/{id}` : champs envoyés seulement ; après activation, voir RG-COT-013. */
export const campagneMajSchema = z.object(champsCampagne).partial();
export type CampagneMaj = z.infer<typeof campagneMajSchema>;

/** `POST /campagnes/{id}/membres` (RG-COT-012). */
export const campagneMembresSchema = z.object({
  membreIds: z.array(z.uuid()).min(1).max(500),
  rattrapage: z.boolean().optional(),
});

/** `PATCH /echeances/{id}` (EcheanceMaj) : ajustement d'une échéance sans imputation (RG-COT-013). */
export const echeanceMajSchema = z
  .object({ montantDu: montantSchema.max(PAIEMENT_MAX), dateEcheance: date })
  .partial()
  .refine((v) => v.montantDu !== undefined || v.dateEcheance !== undefined, {
    message: 'Indiquez un montant ou une date',
  });
export type EcheanceMaj = z.infer<typeof echeanceMajSchema>;

// --- Périodes (RG-COT-011) ---------------------------------------------------------------------------------

export interface Periode {
  numero: number;
  libelle: string;
  /** Première et dernière dates de la période civile, bornées par la campagne. */
  debut: string;
  fin: string;
  dateEcheance: string;
}

const MOIS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
];

const MOIS_PAR_PERIODE: Record<Exclude<Periodicite, 'unique'>, number> = {
  mensuelle: 1,
  trimestrielle: 3,
  semestrielle: 6,
  annuelle: 12,
};

/** Garde-fou : une campagne ne génère pas plus de 120 périodes (10 ans de mensualités). */
export const PERIODES_MAX = 120;

const iso = (a: number, m: number, j: number) =>
  `${String(a).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;

function dernierJour(a: number, m: number): number {
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

function libellePeriode(p: Exclude<Periodicite, 'unique'>, a: number, premierMois: number): string {
  switch (p) {
    case 'mensuelle':
      return `${MOIS[premierMois - 1]} ${a}`;
    case 'trimestrielle':
      return `T${(premierMois + 2) / 3} ${a}`;
    case 'semestrielle':
      return `S${(premierMois + 5) / 6} ${a}`;
    case 'annuelle':
      return String(a);
  }
}

/**
 * Périodes d'une campagne (RG-COT-011) :
 * - `unique` : une échéance à `dateDebut` ;
 * - sinon une période par mois (trimestre, semestre, année) **civil** rencontré entre `dateDebut` et `dateFin`,
 *   échéance au `jourEcheance` du premier mois de la période, ramenée dans `[dateDebut, dateFin]` pour la première
 *   et la dernière période.
 * Les numéros partent de 1 à `dateDebut` : prolonger ou réduire `dateFin` garde les numéros existants.
 */
export function genererPeriodes(c: {
  periodicite: Periodicite;
  dateDebut: string;
  dateFin: string;
  jourEcheance?: number;
}): Periode[] {
  if (c.periodicite === 'unique') {
    return [
      {
        numero: 1,
        libelle: 'Échéance unique',
        debut: c.dateDebut,
        fin: c.dateFin,
        dateEcheance: c.dateDebut,
      },
    ];
  }
  const jour = c.jourEcheance ?? 5;
  const taille = MOIS_PAR_PERIODE[c.periodicite];
  const [a0, m0] = c.dateDebut.split('-').map(Number) as [number, number];
  let annee = a0;
  let mois = Math.floor((m0 - 1) / taille) * taille + 1;
  const periodes: Periode[] = [];
  while (periodes.length < PERIODES_MAX) {
    const debut = iso(annee, mois, 1);
    if (debut > c.dateFin) break;
    const moisFin = mois + taille - 1;
    const fin = iso(annee, moisFin, dernierJour(annee, moisFin));
    let echeance = iso(annee, mois, jour);
    if (echeance < c.dateDebut) echeance = c.dateDebut;
    if (echeance > c.dateFin) echeance = c.dateFin;
    periodes.push({
      numero: periodes.length + 1,
      libelle: libellePeriode(c.periodicite, annee, mois),
      debut: debut < c.dateDebut ? c.dateDebut : debut,
      fin: fin > c.dateFin ? c.dateFin : fin,
      dateEcheance: echeance,
    });
    mois += taille;
    if (mois > 12) {
      mois -= 12;
      annee++;
    }
  }
  return periodes;
}

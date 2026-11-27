import { z } from 'zod';

/**
 * Modèles de messages (docs/06 §5, RF-SUP-042, RF-ADM-023), calcul des unités SMS (docs/06 §4.3) et rendu des
 * variables `{{…}}`. Partagé par l'API (rendu, quotas) et la console (aperçu, compteur d'unités).
 */

export const CANAUX_NOTIFICATION = ['sms', 'whatsapp', 'push', 'email'] as const;
export type CanalNotification = (typeof CANAUX_NOTIFICATION)[number];

export const STATUTS_NOTIFICATION = [
  'en_attente',
  'envoyee',
  'remise',
  'echec',
  'annulee',
  'hors_quota',
] as const;
export type StatutNotification = (typeof STATUTS_NOTIFICATION)[number];

/** Priorité d'une notification : 1 = prioritaire (jamais bloquée par le quota), 5 = rappel, 9 = annonce. */
export const PRIORITE = { prioritaire: 1, normale: 5, annonce: 9 } as const;

export interface DefinitionModele {
  libelle: string;
  canal: CanalNotification;
  variables: readonly string[];
  contenu: string;
  priorite: number;
  /** Personnalisable par une association (l'OTP reste un modèle plateforme). */
  personnalisable: boolean;
}

/** Modèles globaux par défaut (docs/06 §5) : sans accents hors GSM-7, pour tenir en une unité. */
export const MODELES_NOTIFICATION = {
  otp: {
    libelle: 'Code de connexion',
    canal: 'sms',
    variables: ['code'],
    contenu: 'AssoFlow : votre code est {{code}}. Valable 5 min. Ne le communiquez a personne.',
    priorite: PRIORITE.prioritaire,
    personnalisable: false,
  },
  invitation: {
    libelle: 'Invitation à l’application',
    canal: 'sms',
    variables: ['association.nom', 'lien'],
    contenu:
      "{{association.nom}} vous donne acces a AssoFlow. Telechargez l'app : {{lien}} et connectez-vous avec ce numero.",
    priorite: PRIORITE.prioritaire,
    personnalisable: true,
  },
  recu_paiement: {
    libelle: 'Reçu de paiement',
    canal: 'sms',
    variables: [
      'association.sigle',
      'paiement.numero_recu',
      'paiement.montant',
      'membre.prenoms',
      'paiement.date',
      'membre.reste_du',
    ],
    contenu:
      '{{association.sigle}} : recu {{paiement.numero_recu}} - {{paiement.montant}} FCFA recus de {{membre.prenoms}} le {{paiement.date}}. Reste du : {{membre.reste_du}} FCFA.',
    priorite: PRIORITE.prioritaire,
    personnalisable: true,
  },
  annulation_paiement: {
    libelle: 'Annulation de paiement',
    canal: 'sms',
    variables: ['association.sigle', 'paiement.numero_recu', 'paiement.montant', 'motif'],
    contenu:
      '{{association.sigle}} : le recu {{paiement.numero_recu}} de {{paiement.montant}} FCFA a ete annule. Motif : {{motif}}.',
    priorite: PRIORITE.prioritaire,
    personnalisable: true,
  },
  rappel_avant: {
    libelle: 'Rappel avant échéance',
    canal: 'sms',
    variables: ['association.sigle', 'montant', 'date'],
    contenu:
      '{{association.sigle}} : rappel, {{montant}} FCFA de cotisation a regler avant le {{date}}. Merci.',
    priorite: PRIORITE.normale,
    personnalisable: true,
  },
  rappel_retard: {
    libelle: 'Rappel de retard',
    canal: 'sms',
    variables: ['association.sigle', 'montant', 'date'],
    contenu:
      '{{association.sigle}} : votre cotisation de {{montant}} FCFA est en retard depuis le {{date}}. Contactez le tresorier.',
    priorite: PRIORITE.normale,
    personnalisable: true,
  },
  depense_a_valider: {
    libelle: 'Dépense à valider',
    canal: 'sms',
    variables: ['association.sigle', 'depense.numero', 'depense.montant'],
    contenu: '{{association.sigle}} : depense {{depense.numero}} de {{depense.montant}} FCFA a valider.',
    priorite: PRIORITE.prioritaire,
    personnalisable: true,
  },
  depense_decision: {
    libelle: 'Décision sur une dépense',
    canal: 'sms',
    variables: ['association.sigle', 'depense.numero', 'decision'],
    contenu: '{{association.sigle}} : depense {{depense.numero}} {{decision}}.',
    priorite: PRIORITE.prioritaire,
    personnalisable: true,
  },
  convocation: {
    libelle: 'Convocation',
    canal: 'sms',
    variables: ['association.sigle', 'reunion.titre', 'reunion.date', 'reunion.lieu'],
    contenu:
      "{{association.sigle}} : {{reunion.titre}} le {{reunion.date}} a {{reunion.lieu}}. Ordre du jour dans l'app.",
    priorite: PRIORITE.normale,
    personnalisable: true,
  },
  quota_sms: {
    libelle: 'Alerte de quota SMS',
    canal: 'sms',
    variables: ['pourcentage', 'association.nom'],
    contenu: 'AssoFlow : {{pourcentage}}% du quota SMS mensuel de {{association.nom}} utilise.',
    priorite: PRIORITE.normale,
    personnalisable: false,
  },
} as const satisfies Record<string, DefinitionModele>;

export type CodeModele = keyof typeof MODELES_NOTIFICATION;
export const CODES_MODELES = Object.keys(MODELES_NOTIFICATION) as CodeModele[];

export function estCodeModele(code: string): code is CodeModele {
  return Object.prototype.hasOwnProperty.call(MODELES_NOTIFICATION, code);
}

// --- Unités SMS (docs/06 §4.3) -----------------------------------------------------------------------------

/** Alphabet GSM 03.38 de base (1 septet par caractère). */
const GSM7_BASE = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** Table d'extension GSM 03.38 (2 septets : échappement + caractère). */
const GSM7_EXTENSION = new Set('^{}\\[~]|€\f');

export interface CalculSms {
  encodage: 'gsm7' | 'unicode';
  /** Longueur en septets (GSM-7) ou en unités UTF-16 (Unicode). */
  longueur: number;
  unites: number;
  /** Caractères qui font passer le message en Unicode. */
  horsGsm7: string[];
}

/**
 * Unités facturées d'un SMS : GSM-7 → 160 septets pour une unité, 153 par unité au-delà ; Unicode → 70 caractères,
 * 67 par unité au-delà. Un seul caractère hors GSM-7 (`ê`, `ô`, `â`, `ç`, `’`…) fait passer tout le message en Unicode.
 */
export function calculerSms(texte: string): CalculSms {
  const hors = new Set<string>();
  let septets = 0;
  for (const c of texte) {
    if (GSM7_BASE.has(c)) septets += 1;
    else if (GSM7_EXTENSION.has(c)) septets += 2;
    else hors.add(c);
  }
  if (hors.size === 0) {
    return {
      encodage: 'gsm7',
      longueur: septets,
      unites: septets <= 160 ? 1 : Math.ceil(septets / 153),
      horsGsm7: [],
    };
  }
  const longueur = texte.length;
  return {
    encodage: 'unicode',
    longueur,
    unites: longueur <= 70 ? 1 : Math.ceil(longueur / 67),
    horsGsm7: [...hors],
  };
}

export function unitesSms(texte: string): number {
  return calculerSms(texte).unites;
}

// --- Rendu des modèles -------------------------------------------------------------------------------------

const VARIABLE = /\{\{\s*([a-z_]+(?:\.[a-z_]+)*)\s*\}\}/g;

/** Variables `{{…}}` utilisées par un texte, dans l'ordre d'apparition, sans doublon. */
export function variablesDe(texte: string): string[] {
  return [...new Set([...texte.matchAll(VARIABLE)].map((m) => m[1]!))];
}

/** Variables d'un texte personnalisé absentes du modèle (RF-SUP-042 : on surcharge le texte, pas les variables). */
export function variablesInconnues(code: CodeModele, texte: string): string[] {
  const permises = new Set<string>(MODELES_NOTIFICATION[code].variables);
  return variablesDe(texte).filter((v) => !permises.has(v));
}

/**
 * Valeur insérée dans un message : sans accolades ni caractères de contrôle (pas d'injection de variable),
 * espaces normalisés, 80 caractères au plus.
 */
export function echapperValeur(valeur: string | number | null | undefined): string {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur)
    .replace(/[{}]/g, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Rend un modèle : chaque `{{variable}}` est remplacée par sa valeur échappée (vide si absente). */
export function rendreModele(
  texte: string,
  valeurs: Record<string, string | number | null | undefined>,
): string {
  return texte.replace(VARIABLE, (_, nom: string) => echapperValeur(valeurs[nom]));
}

/** Montant pour un SMS : `25 000` (espace simple, GSM-7 ; l'espace insécable n'en fait pas partie). */
export function montantSms(montant: number): string {
  return Math.round(montant)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Date pour un SMS : `AAAA-MM-JJ` → `JJ/MM/AAAA`. */
export function dateSms(dateIso: string): string {
  const [a, m, j] = dateIso.slice(0, 10).split('-');
  return `${j}/${m}/${a}`;
}

/** Valeurs fictives pour l'aperçu d'un modèle (console A21). */
export const EXEMPLE_VARIABLES: Record<string, string> = {
  code: '482913',
  lien: 'https://assoflow.ci/app',
  'association.nom': 'Mutuelle des ressortissants de Kossou',
  'association.sigle': 'MRK',
  'paiement.numero_recu': 'REC-2027-000145',
  'paiement.montant': '25 000',
  'paiement.date': '05/03/2027',
  'membre.prenoms': 'Aya',
  'membre.reste_du': '10 000',
  motif: 'Erreur de saisie',
  montant: '5 000',
  date: '05/04/2027',
  'depense.numero': 'DEP-2027-000012',
  'depense.montant': '150 000',
  decision: 'approuvee',
  'reunion.titre': 'Assemblee generale',
  'reunion.date': '12/04/2027 a 10:00',
  'reunion.lieu': 'Foyer des jeunes',
  pourcentage: '80',
};

/** `PUT /modeles-notification/{code}/{canal}` (ModeleNotification). */
export const modelePersonnaliseSchema = z.object({
  contenu: z.string().trim().min(1, 'Texte obligatoire').max(640, '640 caractères au plus (4 SMS)'),
  langue: z.string().optional(),
});

// --- Réunions et convocations (E6-08) ---------------------------------------------------------------------

export const TYPES_REUNION = ['ag_ordinaire', 'ag_extraordinaire', 'bureau', 'autre'] as const;
export const STATUTS_REUNION = ['planifiee', 'tenue', 'annulee'] as const;

/** `POST /reunions` (Reunion) : planification simple pour la convocation par SMS (RF-063). */
export const reunionCreationSchema = z.object({
  type: z.enum(TYPES_REUNION),
  titre: z.string().trim().min(1, 'Champ obligatoire').max(100),
  debut: z.iso.datetime({ offset: true }),
  lieu: z
    .string()
    .trim()
    .max(100)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  ordreDuJour: z
    .string()
    .trim()
    .max(4000)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
});
export type ReunionCreation = z.infer<typeof reunionCreationSchema>;

/** `POST /reunions/{id}/convoquer` : canal SMS au sprint 4 ; cible = tous, catégories ou sélection. */
export const convocationSchema = z
  .object({
    canaux: z.array(z.enum(['sms', 'whatsapp', 'push'])).optional(),
    cible: z.object({
      tous: z.boolean().optional(),
      categories: z.array(z.uuid()).max(50).optional(),
      membres: z.array(z.uuid()).max(5000).optional(),
    }),
  })
  .superRefine((c, ctx) => {
    const n = [
      c.cible.tous === true,
      Boolean(c.cible.categories?.length),
      Boolean(c.cible.membres?.length),
    ].filter(Boolean).length;
    if (n !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['cible'],
        message: 'Choisissez une cible : tous, des catégories ou des membres',
      });
    }
    if (c.canaux && c.canaux.some((x) => x !== 'sms')) {
      ctx.addIssue({ code: 'custom', path: ['canaux'], message: 'Seul le canal SMS est disponible' });
    }
  });
export type Convocation = z.infer<typeof convocationSchema>;

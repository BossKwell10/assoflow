/**
 * Dictionnaire des statuts partagé (console, app mobile) : un statut s'affiche toujours avec un
 * libellé ET une couleur (docs/08 §2) — vert = payé/validé/actif, orange = en attente/partiel,
 * rouge = en retard/rejeté/suspendu, gris = brouillon/annulé/désactivé.
 */
export type TonStatut = 'succes' | 'attente' | 'alerte' | 'neutre';

export interface DefinitionStatut {
  libelle: string;
  ton: TonStatut;
}

export const STATUTS = {
  /** RG-MBR-004 */
  membreEtat: {
    actif: { libelle: 'Actif', ton: 'succes' },
    suspendu: { libelle: 'Suspendu', ton: 'alerte' },
    desactive: { libelle: 'Désactivé', ton: 'neutre' },
  },
  /** RG-MBR-005 */
  membreAdhesion: {
    actif: { libelle: 'Actif', ton: 'succes' },
    dormant: { libelle: 'Dormant', ton: 'attente' },
    honoraire: { libelle: 'Honoraire', ton: 'succes' },
    bienfaiteur: { libelle: 'Bienfaiteur', ton: 'succes' },
  },
  exercice: {
    ouvert: { libelle: 'Ouvert', ton: 'succes' },
    cloture: { libelle: 'Clôturé', ton: 'neutre' },
  },
  echeance: {
    a_venir: { libelle: 'À venir', ton: 'neutre' },
    partielle: { libelle: 'Partielle', ton: 'attente' },
    payee: { libelle: 'Payée', ton: 'succes' },
    en_retard: { libelle: 'En retard', ton: 'alerte' },
    exoneree: { libelle: 'Exonérée', ton: 'neutre' },
  },
  acces: {
    actif: { libelle: 'Actif', ton: 'succes' },
    revoque: { libelle: 'Révoqué', ton: 'alerte' },
    expire: { libelle: 'Expiré', ton: 'neutre' },
  },
  /** Catégories, paramètres activables. */
  activation: {
    actif: { libelle: 'Active', ton: 'succes' },
    inactif: { libelle: 'Inactive', ton: 'neutre' },
  },
} as const satisfies Record<string, Record<string, DefinitionStatut>>;

export type DomaineStatut = keyof typeof STATUTS;
export type ValeurStatut<D extends DomaineStatut> = keyof (typeof STATUTS)[D] & string;

/** Libellé et ton d'un statut ; une valeur inconnue s'affiche telle quelle, en gris. */
export function definirStatut(domaine: DomaineStatut, valeur: string): DefinitionStatut {
  const dictionnaire: Record<string, DefinitionStatut> = STATUTS[domaine];
  return dictionnaire[valeur] ?? { libelle: valeur, ton: 'neutre' };
}

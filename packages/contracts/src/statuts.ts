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
  campagne: {
    brouillon: { libelle: 'Brouillon', ton: 'neutre' },
    active: { libelle: 'Active', ton: 'succes' },
    cloturee: { libelle: 'Clôturée', ton: 'neutre' },
  },
  /** Paiement effectif, annulé (RG-COT-040) ou ligne d'annulation. */
  paiement: {
    effectif: { libelle: 'Effectif', ton: 'succes' },
    annule: { libelle: 'Annulé', ton: 'neutre' },
    annulation: { libelle: 'Annulation', ton: 'alerte' },
  },
  /** Outbox des notifications (docs/06 §1). */
  notification: {
    en_attente: { libelle: 'En attente', ton: 'attente' },
    envoyee: { libelle: 'Envoyé', ton: 'attente' },
    remise: { libelle: 'Remis', ton: 'succes' },
    echec: { libelle: 'Échec', ton: 'alerte' },
    annulee: { libelle: 'Annulé', ton: 'neutre' },
    hors_quota: { libelle: 'Hors quota', ton: 'alerte' },
  },
  reunion: {
    planifiee: { libelle: 'Planifiée', ton: 'attente' },
    tenue: { libelle: 'Tenue', ton: 'succes' },
    annulee: { libelle: 'Annulée', ton: 'neutre' },
  },
  /** Appareil mobile (E5-06). */
  appareil: {
    actif: { libelle: 'Actif', ton: 'succes' },
    revoque: { libelle: 'Révoqué', ton: 'alerte' },
  },
  /** Rejet de synchronisation (docs/05 §6). */
  rejetSync: {
    a_corriger: { libelle: 'À corriger', ton: 'alerte' },
    acquitte: { libelle: 'Acquitté', ton: 'neutre' },
  },
  tache: {
    en_attente: { libelle: 'En attente', ton: 'attente' },
    en_cours: { libelle: 'En cours', ton: 'attente' },
    terminee: { libelle: 'Terminée', ton: 'succes' },
    echec: { libelle: 'Échec', ton: 'alerte' },
  },
  ligneImport: {
    a_creer: { libelle: 'À créer', ton: 'succes' },
    doublon_probable: { libelle: 'Doublon probable', ton: 'attente' },
    erreur: { libelle: 'Erreur', ton: 'alerte' },
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

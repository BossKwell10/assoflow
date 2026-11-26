/** Catalogue des permissions (docs/04-securite-autorisations.md §4). */
export const PERMISSIONS = [
  'association.lire',
  'association.modifier',
  'exercice.gerer',
  'exercice.cloturer',
  'utilisateur.lire',
  'utilisateur.gerer',
  'role.gerer',
  'delegation.gerer',
  'membre.lire',
  'membre.creer',
  'membre.modifier',
  'membre.importer',
  'membre.suspendre',
  'membre.anonymiser',
  'cotisation.lire',
  'cotisation.gerer',
  'cotisation.exonerer',
  'paiement.enregistrer',
  'paiement.annuler',
  'paiement.annuler_tout',
  'depense.lire',
  'depense.creer',
  'depense.valider',
  'depense.payer',
  'depense.annuler',
  'tresorerie.lire',
  'tresorerie.transferer',
  'tresorerie.ajuster',
  'projet.lire',
  'projet.gerer',
  'reunion.gerer',
  'document.lire',
  'document.gerer',
  'communication.annoncer',
  'communication.modeles',
  'rapport.lire',
  'rapport.exporter',
  'audit.lire',
  'audit.exporter',
  'support.consentir',
  'moi.situation',
  'moi.journal',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSIONS_PLATEFORME = [
  'pf.associations.gerer',
  'pf.demandes.traiter',
  'pf.utilisateurs.gerer',
  'pf.support.acceder',
  'pf.parametres.gerer',
  'pf.statistiques.lire',
  'pf.audit.lire',
] as const;
export type PermissionPlateforme = (typeof PERMISSIONS_PLATEFORME)[number];

/** Réservées aux rôles système « président » (non attribuables à un rôle personnalisé). */
export const PERMISSIONS_RESERVEES_PRESIDENT: readonly Permission[] = [
  'utilisateur.gerer',
  'role.gerer',
  'association.modifier',
];

const LECTURE_BUREAU: Permission[] = [
  'association.lire',
  'utilisateur.lire',
  'membre.lire',
  'cotisation.lire',
  'depense.lire',
  'document.lire',
  'projet.lire',
  'rapport.lire',
  'moi.situation',
  'moi.journal',
];

/** Rôles système créés à l'ouverture d'un tenant (RG-ASS-001). */
export const ROLES_SYSTEME: Record<
  'president' | 'tresorier' | 'secretaire' | 'commissaire' | 'membre',
  {
    libelle: string;
    permissions: Permission[];
  }
> = {
  president: {
    libelle: 'Président',
    permissions: PERMISSIONS.filter((p) => p !== 'depense.payer'),
  },
  tresorier: {
    libelle: 'Trésorier',
    permissions: [
      ...LECTURE_BUREAU,
      'exercice.gerer',
      'membre.creer',
      'membre.modifier',
      'cotisation.gerer',
      'paiement.enregistrer',
      'paiement.annuler',
      'depense.creer',
      'depense.payer',
      'depense.annuler',
      'tresorerie.lire',
      'tresorerie.transferer',
      'projet.gerer',
      'rapport.exporter',
    ],
  },
  secretaire: {
    libelle: 'Secrétaire',
    permissions: [
      ...LECTURE_BUREAU,
      'membre.creer',
      'membre.modifier',
      'membre.importer',
      'membre.suspendre',
      'projet.gerer',
      'reunion.gerer',
      'document.gerer',
      'communication.annoncer',
      'communication.modeles',
      'rapport.exporter',
    ],
  },
  commissaire: {
    libelle: 'Commissaire aux comptes',
    permissions: [...LECTURE_BUREAU, 'tresorerie.lire', 'rapport.exporter', 'audit.lire', 'audit.exporter'],
  },
  membre: {
    libelle: 'Membre',
    permissions: ['association.lire', 'projet.lire', 'moi.situation', 'moi.journal'],
  },
};

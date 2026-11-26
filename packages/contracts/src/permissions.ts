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

/** Libellés du catalogue (`GET /v1/permissions`), dans l'ordre de docs/04 §4. */
export const LIBELLES_PERMISSIONS: Record<Permission, string> = {
  'association.lire': "Consulter l'association",
  'association.modifier': "Modifier le profil et les paramètres de l'association",
  'exercice.gerer': 'Gérer les exercices',
  'exercice.cloturer': 'Clôturer un exercice',
  'utilisateur.lire': 'Consulter les accès',
  'utilisateur.gerer': 'Gérer les accès (invitation, rôle, révocation)',
  'role.gerer': 'Gérer les rôles',
  'delegation.gerer': 'Gérer les délégations',
  'membre.lire': 'Consulter les membres',
  'membre.creer': 'Créer des membres',
  'membre.modifier': 'Modifier des membres',
  'membre.importer': 'Importer des membres',
  'membre.suspendre': 'Suspendre, réactiver, désactiver des membres',
  'membre.anonymiser': 'Anonymiser un membre',
  'cotisation.lire': 'Consulter les cotisations',
  'cotisation.gerer': 'Gérer les campagnes et échéanciers',
  'cotisation.exonerer': 'Exonérer une échéance',
  'paiement.enregistrer': 'Enregistrer des paiements',
  'paiement.annuler': 'Annuler ses paiements récents',
  'paiement.annuler_tout': 'Annuler tout paiement',
  'depense.lire': 'Consulter les dépenses',
  'depense.creer': 'Créer des dépenses',
  'depense.valider': 'Valider des dépenses',
  'depense.payer': 'Payer des dépenses',
  'depense.annuler': 'Annuler des dépenses',
  'tresorerie.lire': 'Consulter la trésorerie',
  'tresorerie.transferer': 'Transférer entre comptes et gérer les comptes',
  'tresorerie.ajuster': 'Ajuster la trésorerie',
  'projet.lire': 'Consulter les projets',
  'projet.gerer': 'Gérer les projets',
  'reunion.gerer': 'Gérer les réunions',
  'document.lire': 'Consulter les documents',
  'document.gerer': 'Gérer les documents',
  'communication.annoncer': 'Publier des annonces',
  'communication.modeles': 'Gérer les modèles de messages',
  'rapport.lire': 'Consulter les rapports',
  'rapport.exporter': 'Exporter les rapports',
  'audit.lire': "Consulter le journal d'audit",
  'audit.exporter': "Exporter le journal d'audit",
  'support.consentir': 'Consentir aux accès du support',
  'moi.situation': 'Consulter sa situation',
  'moi.journal': 'Consulter le journal public et les annonces',
};

/** Permissions des rôles plateforme (docs/04 §4). */
export const PERMISSIONS_ROLES_PLATEFORME: Record<
  'super_admin' | 'support',
  readonly PermissionPlateforme[]
> = {
  super_admin: PERMISSIONS_PLATEFORME,
  support: ['pf.support.acceder', 'pf.statistiques.lire'],
};

export function estPermission(code: string): code is Permission {
  return (PERMISSIONS as readonly string[]).includes(code);
}

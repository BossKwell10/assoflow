import { ROLES_SYSTEME, type Permission } from '@assoflow/contracts';
import type {
  Acces,
  Association,
  CategorieMembre,
  Famille,
  Membre,
  Permission as PermissionApi,
  Role,
  Session,
  UtilisateurMoi,
} from '../api/generated/modeles';

export const ASSO_A = '0193a000-0000-7000-8000-00000000000a';
export const ASSO_B = '0193a000-0000-7000-8000-00000000000b';

/** JWT factice (non signé) : la console ne lit que les claims, le serveur fait foi. */
export function jetonFactice(claims: Record<string, string> = {}): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64({ sub: 'u1', sid: 's1', can: 'console', ...claims })}.signature`;
}

export function utilisateur({
  permissions = ROLES_SYSTEME.president.permissions,
  role = { code: 'president', libelle: 'Président' },
  totpActif = true,
  associations = [{ associationId: ASSO_A, associationNom: 'Mutuelle de Bécédi' }],
}: {
  permissions?: readonly Permission[];
  role?: { code: string; libelle: string };
  totpActif?: boolean;
  associations?: { associationId: string; associationNom: string }[];
} = {}): UtilisateurMoi {
  return {
    id: '0193a000-0000-7000-8000-000000000001',
    telephone: '+2250701020304',
    email: 'awa.kone@exemple.ci',
    nom: 'Koné',
    prenoms: 'Awa',
    totpActif,
    rolePlateforme: null,
    acces: associations.map((a) => ({ ...a, role, permissions: [...permissions] })),
  };
}

export function session(
  u: UtilisateurMoi = utilisateur(),
  aid: string | null | undefined = u.acces[0]?.associationId,
): Session {
  return { accessToken: jetonFactice(aid ? { aid } : {}), expireDans: 600, utilisateur: u };
}

export const ROLES: Role[] = (
  Object.entries(ROLES_SYSTEME) as [string, (typeof ROLES_SYSTEME)['president']][]
).map(([code, r], i) => ({
  id: `0193a000-0000-7000-8000-0000000001${i}0`,
  code,
  libelle: r.libelle,
  permissions: [...r.permissions],
  systeme: true,
}));

export const PERMISSIONS_API: PermissionApi[] = [
  {
    code: 'utilisateur.lire',
    module: 'utilisateur',
    libelle: 'Voir les utilisateurs',
    reserveePresident: false,
  },
  {
    code: 'utilisateur.gerer',
    module: 'utilisateur',
    libelle: 'Gérer les utilisateurs',
    reserveePresident: true,
  },
  { code: 'depense.payer', module: 'depense', libelle: 'Payer une dépense', reserveePresident: false },
];

export function acces(partiel: Partial<Acces> & { nom: string; prenoms: string }): Acces {
  const { nom, prenoms, ...reste } = partiel;
  return {
    id: crypto.randomUUID(),
    user: {
      id: crypto.randomUUID(),
      telephone: '+2250102030405',
      nom,
      prenoms,
      derniereConnexion: '2027-03-05T14:30:00Z',
      verrouille: false,
    },
    role: ROLES[1]!,
    membreId: null,
    mandatDebut: '2026-01-01',
    mandatFin: null,
    statut: 'actif',
    ...reste,
  };
}

// --- Membres (sprint 2)
export const CATEGORIES_MEMBRES: CategorieMembre[] = [
  { id: '0193a000-0000-7000-8000-0000000002a1', libelle: 'Membre ordinaire', description: null, actif: true },
  { id: '0193a000-0000-7000-8000-0000000002a2', libelle: 'Membre d’honneur', description: null, actif: true },
];

export const FAMILLES: Famille[] = [
  {
    id: '0193a000-0000-7000-8000-0000000003f1',
    nom: 'Famille Kouassi',
    villageOrigine: 'Bécédi',
    nombreMembres: 2,
  },
];

let numero = 0;
export function membre(partiel: Partial<Membre> & { nom: string; prenoms: string }): Membre {
  numero += 1;
  return {
    id: crypto.randomUUID(),
    numero: `MBR-${String(numero).padStart(6, '0')}`,
    sexe: null,
    dateNaissance: null,
    telephone: null,
    telephoneWhatsapp: false,
    email: null,
    villageOrigine: 'Bécédi',
    lieuResidence: null,
    paysResidence: 'CI',
    estDiaspora: false,
    photoUrl: null,
    categorieId: CATEGORIES_MEMBRES[0]!.id,
    familleId: null,
    statutAdhesion: 'actif',
    etat: 'actif',
    motifEtat: null,
    dateAdhesion: '2026-01-15',
    canalPrefere: 'sms',
    notes: null,
    aAccesApp: false,
    soldeCotisations: 0,
    doublonProbable: false,
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:00:00Z',
    ...partiel,
  };
}
export const reinitialiserNumeros = () => {
  numero = 0;
};

export function membresParDefaut(): Membre[] {
  reinitialiserNumeros();
  return [
    membre({
      nom: 'Kouassi',
      prenoms: 'Jean',
      telephone: '+2250701020304',
      familleId: FAMILLES[0]!.id,
      soldeCotisations: -15000,
    }),
    membre({ nom: 'Kouassi', prenoms: 'Adjoua', familleId: FAMILLES[0]!.id }),
    membre({
      nom: 'Diabaté',
      prenoms: 'Fanta',
      telephone: '+33612345678',
      paysResidence: 'FR',
      estDiaspora: true,
      aAccesApp: true,
    }),
    membre({
      nom: 'Yao',
      prenoms: 'Paul',
      telephone: '+2250505050505',
      etat: 'suspendu',
      motifEtat: 'Absences',
    }),
  ];
}

export function session_commissaire(): Session {
  return session(
    utilisateur({
      role: { code: 'commissaire', libelle: 'Commissaire aux comptes' },
      permissions: ROLES_SYSTEME.commissaire.permissions,
    }),
  );
}

export function session_secretaire(): Session {
  return session(
    utilisateur({
      role: { code: 'secretaire', libelle: 'Secrétaire' },
      permissions: ROLES_SYSTEME.secretaire.permissions,
    }),
  );
}

export const ASSOCIATION: Association = {
  id: ASSO_A,
  nom: 'Mutuelle de Bécédi',
  sigle: 'MUBE',
  type: 'mutuelle_developpement',
  village: 'Bécédi',
  sousPrefecture: 'Bécédi-Brignan',
  region: 'Agnéby-Tiassa',
  dateCreation: '2010-05-01',
  recepisseNumero: null,
  recepisseDate: null,
  prefectureDepot: null,
  telephone: '+2250701020304',
  email: null,
  logoUrl: null,
  devise: 'XOF',
  moisDebutExercice: 1,
  seuilDoubleValidation: 100000,
  seuilAlerteSolde: 50000,
  joursRetardDormant: 180,
  journalPublicActif: false,
  statut: 'active',
  plan: 'gratuit',
  quotaSmsMensuel: 500,
};

export function session_tresorier(): Session {
  return session(
    utilisateur({
      role: { code: 'tresorier', libelle: 'Trésorier' },
      permissions: ROLES_SYSTEME.tresorier.permissions,
    }),
  );
}

import { ROLES_SYSTEME, type Permission } from '@assoflow/contracts';
import type {
  Acces,
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

import type { Permission } from '@assoflow/contracts';
import { Alert, Button, Center, Loader, Stack } from '@mantine/core';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouteComponent,
} from '@tanstack/react-router';
import { ExigerPermission } from './auth/AccesRefuse';
import { ExigerEspaceAssociation, ExigerSession } from './auth/Gardes';
import { t } from './i18n';
import { Coquille } from './layout/Coquille';
import { APlusTard } from './routes/APlusTard';

const rechercheRedirection = (recherche: Record<string, unknown>): { redirect?: string } =>
  typeof recherche.redirect === 'string' ? { redirect: recherche.redirect } : {};

/** Composant chargé à la demande puis protégé par permission (docs/08 §2 : routes chargées à la demande). */
function protege(permission: Permission | readonly Permission[], Composant: RouteComponent): RouteComponent {
  const Protege = () => (
    <ExigerPermission permission={permission}>
      <Composant />
    </ExigerPermission>
  );
  return Protege;
}

const Attente = () => (
  <Center p="xl">
    <Loader aria-label={t('commun.chargement')} />
  </Center>
);

const ErreurInattendue = () => (
  <Center p="xl">
    <Stack maw={480}>
      <Alert color="red" role="alert">
        {t('commun.erreurInattendue')}
      </Alert>
      <Button variant="default" onClick={() => window.location.reload()}>
        {t('commun.recharger')}
      </Button>
    </Stack>
  </Center>
);

const racine = createRootRoute({
  component: Outlet,
  pendingComponent: Attente,
  errorComponent: ErreurInattendue,
});

// --- Écrans publics (A0)
const connexion = createRoute({
  getParentRoute: () => racine,
  path: '/connexion',
  validateSearch: rechercheRedirection,
  component: lazyRouteComponent(() => import('./features/auth/Connexion'), 'Connexion'),
});
const motDePasseOublie = createRoute({
  getParentRoute: () => racine,
  path: '/mot-de-passe-oublie',
  component: lazyRouteComponent(() => import('./features/auth/DefinitionMotDePasse'), 'MotDePasseOublie'),
});
const premierAcces = createRoute({
  getParentRoute: () => racine,
  path: '/premier-acces',
  component: lazyRouteComponent(() => import('./features/auth/DefinitionMotDePasse'), 'PremierAcces'),
});

// --- Écran de session hors coquille
const ChoixAssociation = lazyRouteComponent(
  () => import('./features/auth/ChoixAssociation'),
  'ChoixAssociation',
);
const choixAssociation = createRoute({
  getParentRoute: () => racine,
  path: '/choix-association',
  validateSearch: rechercheRedirection,
  component: () => (
    <ExigerSession>
      <ChoixAssociation />
    </ExigerSession>
  ),
});

// --- Espace association (coquille protégée)
const espace = createRoute({
  getParentRoute: () => racine,
  id: 'espace',
  component: () => (
    <ExigerEspaceAssociation>
      <Coquille />
    </ExigerEspaceAssociation>
  ),
});

const ecrans: { path: string; titre: string; sprint: string; permission: Permission | Permission[] }[] = [
  { path: '/membres', titre: t('menu.membres'), sprint: 'sprint 2', permission: 'membre.lire' },
  { path: '/cotisations', titre: t('menu.cotisations'), sprint: 'sprint 3', permission: 'cotisation.lire' },
  {
    path: '/tresorerie',
    titre: t('menu.tresorerie'),
    sprint: 'sprint 6',
    permission: ['tresorerie.lire', 'depense.lire'],
  },
  { path: '/depenses', titre: t('menu.depenses'), sprint: 'sprint 6', permission: 'depense.lire' },
  { path: '/projets', titre: t('menu.projets'), sprint: 'phase 2', permission: 'projet.lire' },
  { path: '/rapports', titre: t('menu.rapports'), sprint: 'sprint 7', permission: 'rapport.lire' },
];

/** Route de l'espace association protégée par permission ; le composant est chargé à la demande. */
const ecran = <P extends string>(path: P, permission: Permission | Permission[], composant: RouteComponent) =>
  createRoute({ getParentRoute: () => espace, path, component: protege(permission, composant) });

export const routeTree = racine.addChildren([
  connexion,
  motDePasseOublie,
  premierAcces,
  choixAssociation,
  espace.addChildren([
    createRoute({
      getParentRoute: () => espace,
      path: '/',
      component: protege(
        'rapport.lire',
        lazyRouteComponent(() => import('./routes/TableauDeBord'), 'TableauDeBord'),
      ),
    }),
    ...ecrans.map((e) =>
      createRoute({
        getParentRoute: () => espace,
        path: e.path,
        component: protege(e.permission, () => <APlusTard titre={e.titre} sprint={e.sprint} />),
      }),
    ),
    createRoute({
      getParentRoute: () => espace,
      path: '/parametres',
      component: protege(
        ['association.modifier', 'exercice.gerer', 'utilisateur.lire', 'delegation.gerer'],
        lazyRouteComponent(() => import('./features/parametres/Parametres'), 'Parametres'),
      ),
    }),
    ecran(
      '/parametres/association',
      'association.modifier',
      lazyRouteComponent(
        () => import('./features/parametres/ParametresAssociation'),
        'ParametresAssociation',
      ),
    ),
    ecran(
      '/parametres/exercices',
      ['exercice.gerer', 'exercice.cloturer'],
      lazyRouteComponent(() => import('./features/parametres/Exercices'), 'Exercices'),
    ),
    ecran(
      '/parametres/categories',
      'association.modifier',
      lazyRouteComponent(() => import('./features/parametres/Categories'), 'Categories'),
    ),
    createRoute({
      getParentRoute: () => espace,
      path: '/parametres/utilisateurs',
      component: protege(
        ['utilisateur.lire', 'utilisateur.gerer'],
        lazyRouteComponent(() => import('./features/parametres/UtilisateursRoles'), 'UtilisateursRoles'),
      ),
    }),
  ]),
]);

export const creerRouteur = () => createRouter({ routeTree, defaultPendingComponent: Attente });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof creerRouteur>;
  }
}

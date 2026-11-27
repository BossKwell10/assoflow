import type { Permission } from '@assoflow/contracts';
import { Alert, Button, Center, Loader, Stack } from '@mantine/core';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouteComponent,
} from '@tanstack/react-router';
import { ExigerPermission } from './auth/AccesRefuse';
import { ExigerEspaceAssociation, ExigerSession } from './auth/Gardes';
import { t } from './i18n';
import { Coquille } from './layout/Coquille';
import { validerRechercheCampagnes, validerRechercheEcheances } from './features/cotisations/recherche';
import { validerRechercheFamilles, validerRechercheMembres } from './features/membres/recherche';
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

// --- Membres (A2 à A7, sprint 2)
const membres = createRoute({
  getParentRoute: () => espace,
  path: '/membres',
  validateSearch: validerRechercheMembres,
  component: protege(
    'membre.lire',
    lazyRouteComponent(() => import('./features/membres/ListeMembres'), 'ListeMembres'),
  ),
});
const familles = createRoute({
  getParentRoute: () => espace,
  path: '/membres/familles',
  validateSearch: validerRechercheFamilles,
  component: protege(
    'membre.lire',
    lazyRouteComponent(() => import('./features/membres/Familles'), 'ListeFamilles'),
  ),
});

// --- Cotisations (A8 à A10, sprint 3)
const cotisations = createRoute({
  getParentRoute: () => espace,
  path: '/cotisations',
  beforeLoad: () => {
    throw redirect({ to: '/cotisations/campagnes' });
  },
});
const campagnes = createRoute({
  getParentRoute: () => espace,
  path: '/cotisations/campagnes',
  validateSearch: validerRechercheCampagnes,
  component: protege(
    'cotisation.lire',
    lazyRouteComponent(() => import('./features/cotisations/ListeCampagnes'), 'ListeCampagnes'),
  ),
});
const echeances = createRoute({
  getParentRoute: () => espace,
  path: '/cotisations/echeances',
  validateSearch: validerRechercheEcheances,
  component: protege(
    'cotisation.lire',
    lazyRouteComponent(() => import('./features/cotisations/Echeances'), 'Echeances'),
  ),
});

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
    membres,
    familles,
    ecran(
      '/membres/familles/$id',
      'membre.lire',
      lazyRouteComponent(() => import('./features/membres/Familles'), 'FicheFamille'),
    ),
    ecran(
      '/membres/doublons',
      'membre.lire',
      lazyRouteComponent(() => import('./features/membres/Doublons'), 'Doublons'),
    ),
    ecran(
      '/membres/import',
      'membre.importer',
      lazyRouteComponent(() => import('./features/membres/ImportMembres'), 'ImportMembres'),
    ),
    cotisations,
    campagnes,
    echeances,
    ecran(
      '/cotisations/campagnes/nouvelle',
      'cotisation.gerer',
      lazyRouteComponent(() => import('./features/cotisations/FormulaireCampagne'), 'NouvelleCampagne'),
    ),
    ecran(
      '/cotisations/campagnes/$id',
      'cotisation.lire',
      lazyRouteComponent(() => import('./features/cotisations/DetailCampagne'), 'DetailCampagne'),
    ),
    ecran(
      '/cotisations/campagnes/$id/modifier',
      'cotisation.gerer',
      lazyRouteComponent(() => import('./features/cotisations/FormulaireCampagne'), 'ModificationCampagne'),
    ),
    ecran(
      '/membres/nouveau',
      'membre.creer',
      lazyRouteComponent(() => import('./features/membres/FormulaireMembre'), 'NouveauMembre'),
    ),
    ecran(
      '/membres/$id',
      'membre.lire',
      lazyRouteComponent(() => import('./features/membres/FicheMembre'), 'FicheMembre'),
    ),
    ecran(
      '/membres/$id/modifier',
      'membre.modifier',
      lazyRouteComponent(() => import('./features/membres/FormulaireMembre'), 'ModificationMembre'),
    ),
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

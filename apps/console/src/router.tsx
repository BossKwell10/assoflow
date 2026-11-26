import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Coquille } from './layout/Coquille';
import { APlusTard } from './routes/APlusTard';
import { TableauDeBord } from './routes/TableauDeBord';

const racine = createRootRoute({ component: Coquille });

const ecrans = [
  { path: '/membres', titre: 'Membres', sprint: 'sprint 2' },
  { path: '/cotisations', titre: 'Cotisations', sprint: 'sprint 3' },
  { path: '/tresorerie', titre: 'Trésorerie', sprint: 'sprint 6' },
  { path: '/depenses', titre: 'Dépenses', sprint: 'sprint 6' },
  { path: '/projets', titre: 'Projets', sprint: 'phase 2' },
  { path: '/rapports', titre: 'Rapports', sprint: 'sprint 7' },
  { path: '/parametres', titre: 'Paramètres', sprint: 'sprint 2' },
];

export const routeTree = racine.addChildren([
  createRoute({ getParentRoute: () => racine, path: '/', component: TableauDeBord }),
  ...ecrans.map((e) =>
    createRoute({
      getParentRoute: () => racine,
      path: e.path,
      component: () => <APlusTard titre={e.titre} sprint={e.sprint} />,
    }),
  ),
]);

export const creerRouteur = () => createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof creerRouteur>;
  }
}

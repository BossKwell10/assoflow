import { AppShell, Burger, Group, NavLink, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';

const MENU = [
  { lien: '/', libelle: 'Tableau de bord' },
  { lien: '/membres', libelle: 'Membres' },
  { lien: '/cotisations', libelle: 'Cotisations' },
  { lien: '/tresorerie', libelle: 'Trésorerie' },
  { lien: '/depenses', libelle: 'Dépenses' },
  { lien: '/projets', libelle: 'Projets' },
  { lien: '/rapports', libelle: 'Rapports' },
  { lien: '/parametres', libelle: 'Paramètres' },
] as const;

/** Coquille de l'espace association (docs/08 §4.1). */
export function Coquille() {
  const [ouvert, { toggle }] = useDisclosure();
  const chemin = useRouterState({ select: (s) => s.location.pathname });

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !ouvert } }}
      padding="lg"
      styles={{ main: { background: '#F6F7F9' } }}
    >
      <AppShell.Header px="lg">
        <Group h="100%" justify="space-between">
          <Group>
            <Burger opened={ouvert} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Ouvrir le menu" />
            <ThemeIcon size={32} radius="md">
              A
            </ThemeIcon>
            <Text ff="heading" fw={700} size="lg">
              AssoFlow
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Aucune association sélectionnée
          </Text>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        <Stack gap={2} component="nav" aria-label="Navigation principale">
          {MENU.map((m) => (
            <NavLink
              key={m.lien}
              component={Link}
              to={m.lien}
              label={m.libelle}
              active={chemin === m.lien}
              aria-current={chemin === m.lien ? 'page' : undefined}
            />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

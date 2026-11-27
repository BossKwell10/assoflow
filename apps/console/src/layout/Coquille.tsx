import type { Permission } from '@assoflow/contracts';
import {
  AppShell,
  Burger,
  Group,
  Menu,
  NavLink,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
  Avatar,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useGetExercices } from '../api/generated/association/association';
import { useSession } from '../auth/SessionProvider';
import { useAuMoinsUnePermission } from '../auth/Si';
import { t, type CleTexte } from '../i18n';

/** Menu de l'espace association et permission minimale de chaque entrée (docs/08 §4.1). */
export const MENU: { lien: string; cle: CleTexte; permissions: readonly Permission[] }[] = [
  { lien: '/', cle: 'menu.tableauDeBord', permissions: ['rapport.lire'] },
  { lien: '/membres', cle: 'menu.membres', permissions: ['membre.lire'] },
  { lien: '/cotisations/campagnes', cle: 'menu.cotisations', permissions: ['cotisation.lire'] },
  { lien: '/cotisations/paiements', cle: 'menu.paiements', permissions: ['cotisation.lire'] },
  {
    lien: '/cotisations/paiements/saisie',
    cle: 'menu.saisiePaiements',
    permissions: ['paiement.enregistrer'],
  },
  { lien: '/tresorerie', cle: 'menu.tresorerie', permissions: ['tresorerie.lire', 'depense.lire'] },
  { lien: '/depenses', cle: 'menu.depenses', permissions: ['depense.lire'] },
  { lien: '/projets', cle: 'menu.projets', permissions: ['projet.lire'] },
  { lien: '/reunions', cle: 'menu.reunions', permissions: ['reunion.gerer'] },
  {
    lien: '/communication',
    cle: 'menu.communication',
    permissions: ['communication.annoncer', 'communication.modeles'],
  },
  { lien: '/rapports', cle: 'menu.rapports', permissions: ['rapport.lire'] },
  {
    lien: '/parametres',
    cle: 'menu.parametres',
    permissions: ['association.modifier', 'exercice.gerer', 'utilisateur.lire', 'delegation.gerer'],
  },
];

/** Entrée de menu active : celle dont le lien est le plus long préfixe du chemin (Paiements ≠ Saisie). */
export function lienActif(chemin: string): string | undefined {
  return MENU.map((m) => m.lien)
    .filter((l) => (l === '/' ? chemin === '/' : chemin === l || chemin.startsWith(`${l}/`)))
    .sort((a, b) => b.length - a.length)[0];
}

function EntreeMenu({ entree, chemin }: { entree: (typeof MENU)[number]; chemin: string }) {
  const visible = useAuMoinsUnePermission(entree.permissions);
  if (!visible) return null;
  const actif = entree.lien === lienActif(chemin);
  return (
    <NavLink
      component={Link}
      to={entree.lien}
      label={t(entree.cle)}
      active={actif}
      aria-current={actif ? 'page' : undefined}
      mih={44}
    />
  );
}

/**
 * Exercice ouvert le plus récent (docs/08 §4.1). En cas d'erreur (API indisponible, endpoint non
 * déployé), l'en-tête l'indique sobrement sans bloquer la console ni réessayer en boucle.
 */
function Exercice() {
  const lecture = useAuMoinsUnePermission('association.lire');
  const exercices = useGetExercices({ query: { enabled: lecture, staleTime: 5 * 60_000, retry: false } });
  if (!lecture || exercices.isPending) return null;
  if (exercices.isError)
    return (
      <Text size="xs" c="dimmed">
        {t('entete.exerciceIndisponible')}
      </Text>
    );
  const ouvert = exercices.data
    .filter((e) => e.statut === 'ouvert')
    .sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))[0];
  return (
    <Text size="xs" c={ouvert ? 'dimmed' : '#8A4B00'}>
      {ouvert ? t('entete.exercice', { libelle: ouvert.libelle }) : t('entete.aucunExercice')}
    </Text>
  );
}

function SelecteurAssociation() {
  const { utilisateur, associationActive, choisirAssociation } = useSession();
  const acces = utilisateur?.acces ?? [];
  const nom = associationActive?.associationNom ?? t('entete.aucuneAssociation');
  const identite = (
    <div>
      <Text fw={600} size="sm" lh={1.2}>
        {nom}
      </Text>
      <Exercice />
    </div>
  );
  if (acces.length < 2) return identite;
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label={`${t('entete.changerAssociation')} — ${nom}`} mih={44} px="xs">
          <Group gap={6}>
            {identite}
            <Text aria-hidden size="xs">
              ▾
            </Text>
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('entete.associations')}</Menu.Label>
        {acces.map((a) => (
          <Menu.Item
            key={a.associationId}
            onClick={() => a.associationId && void choisirAssociation(a.associationId)}
            disabled={a.associationId === associationActive?.associationId}
          >
            {a.associationNom}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function MenuUtilisateur() {
  const { utilisateur, associationActive, deconnecter } = useSession();
  if (!utilisateur) return null;
  const nom = `${utilisateur.prenoms} ${utilisateur.nom}`;
  const initiales = `${utilisateur.prenoms.charAt(0)}${utilisateur.nom.charAt(0)}`.toUpperCase();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label={t('entete.menuUtilisateur')} mih={44} px="xs">
          <Group gap="xs">
            <Avatar radius="xl" size={32} color="accent" aria-hidden>
              {initiales}
            </Avatar>
            <Text size="sm" visibleFrom="sm">
              {nom}
            </Text>
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="sm" fw={600} c="dark">
            {nom}
          </Text>
          {associationActive?.role?.libelle && <Text size="xs">{associationActive.role.libelle}</Text>}
        </Menu.Label>
        <Menu.Divider />
        <Menu.Item onClick={() => void deconnecter('volontaire')}>{t('entete.seDeconnecter')}</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

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
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Burger
              opened={ouvert}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={t('menu.ouvrir')}
            />
            <ThemeIcon size={32} radius="md" aria-hidden>
              A
            </ThemeIcon>
            <Text ff="heading" fw={700} size="lg" visibleFrom="xs">
              {t('app.nom')}
            </Text>
            <SelecteurAssociation />
          </Group>
          <MenuUtilisateur />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        <Stack gap={2} component="nav" aria-label={t('menu.navigation')}>
          {MENU.map((m) => (
            <EntreeMenu key={m.lien} entree={m} chemin={chemin} />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

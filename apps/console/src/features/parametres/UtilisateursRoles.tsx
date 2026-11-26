import { Stack, Tabs, Title } from '@mantine/core';
import { t } from '../../i18n';
import { ListeAcces } from './ListeAcces';
import { MatriceRoles } from './MatriceRoles';

/** A30 — Paramètres › Utilisateurs et rôles (version sprint 1). RF-ADM-010 à 015. */
export function UtilisateursRoles() {
  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        {t('utilisateurs.titre')}
      </Title>
      <Tabs defaultValue="utilisateurs" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="utilisateurs">{t('utilisateurs.ongletUtilisateurs')}</Tabs.Tab>
          <Tabs.Tab value="roles">{t('utilisateurs.ongletRoles')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="utilisateurs" pt="lg">
          <ListeAcces />
        </Tabs.Panel>
        <Tabs.Panel value="roles" pt="lg">
          <MatriceRoles />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

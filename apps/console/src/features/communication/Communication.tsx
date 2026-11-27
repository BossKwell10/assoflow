import { Stack, Tabs, Title } from '@mantine/core';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { Historique } from './Historique';
import { Modeles } from './Modeles';
import type { RechercheCommunication } from './recherche';

/** Communication (docs/08 A20–A22) : modèles de messages et historique des envois. Annonces en phase 2. */
export function Communication() {
  const { recherche, modifier } = useRechercheTableau<RechercheCommunication>();
  const modeles = useAuMoinsUnePermission('communication.modeles');
  const historique = useAuMoinsUnePermission('communication.annoncer');
  const defaut = historique ? 'historique' : 'modeles';
  const onglet =
    recherche.onglet === 'modeles' && modeles
      ? 'modeles'
      : recherche.onglet === 'historique' && historique
        ? 'historique'
        : defaut;

  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        {t('communication.titre')}
      </Title>
      <Tabs
        value={onglet}
        onChange={(v) =>
          modifier({ onglet: v ?? undefined, statut: undefined, modele: undefined, membreId: undefined })
        }
        keepMounted={false}
      >
        <Tabs.List>
          {historique && <Tabs.Tab value="historique">{t('communication.ongletHistorique')}</Tabs.Tab>}
          {modeles && <Tabs.Tab value="modeles">{t('communication.ongletModeles')}</Tabs.Tab>}
        </Tabs.List>
        {historique && (
          <Tabs.Panel value="historique" pt="lg">
            <Historique />
          </Tabs.Panel>
        )}
        {modeles && (
          <Tabs.Panel value="modeles" pt="lg">
            <Modeles />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  );
}

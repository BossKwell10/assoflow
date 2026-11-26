import { Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useGetHealthReady } from '../api/generated/sante/sante';
import { t, type CleTexte } from '../i18n';
import { Montant } from '../shared/Montant';
import { Statut } from '../shared/Statut';

const CARTES: [CleTexte, number][] = [
  ['tableauDeBord.recettes', 0],
  ['tableauDeBord.depenses', 0],
  ['tableauDeBord.solde', 0],
];

/** A1 — sera branché sur GET /v1/tableau-de-bord (sprint 7). */
export function TableauDeBord() {
  const sante = useGetHealthReady({ query: { retry: false } });

  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        {t('tableauDeBord.titre')}
      </Title>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {CARTES.map(([cle, valeur]) => (
          <Card key={cle} withBorder radius="lg" padding="lg">
            <Text size="sm" c="dimmed">
              {t(cle)}
            </Text>
            <Montant valeur={valeur} size="xl" />
          </Card>
        ))}
        <Card withBorder radius="lg" padding="lg">
          <Text size="sm" c="dimmed">
            {t('tableauDeBord.api')}
          </Text>
          <Group mt={6}>
            {sante.isPending && <Statut ton="neutre">{t('tableauDeBord.verification')}</Statut>}
            {sante.isError && <Statut ton="alerte">{t('tableauDeBord.injoignable')}</Statut>}
            {sante.data && (
              <Statut ton={sante.data.statut === 'ok' ? 'succes' : 'attente'}>
                {sante.data.statut === 'ok' ? t('tableauDeBord.operationnelle') : t('tableauDeBord.degradee')}
              </Statut>
            )}
          </Group>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

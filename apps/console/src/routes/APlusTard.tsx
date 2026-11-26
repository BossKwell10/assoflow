import { Card, Stack, Text, Title } from '@mantine/core';
import { t } from '../i18n';

/** Écran prévu dans docs/08-console-specification.md, livré dans un sprint ultérieur. */
export function APlusTard({ titre, sprint }: { titre: string; sprint: string }) {
  return (
    <Stack maw={1240}>
      <Title order={1} size={28}>
        {titre}
      </Title>
      <Card withBorder radius="lg" padding="lg">
        <Text c="dimmed">{t('aPlusTard.message', { sprint })}</Text>
      </Card>
    </Stack>
  );
}

import { Card, Stack, Text, Title } from '@mantine/core';

/** Écran prévu dans docs/08-console-specification.md, livré dans un sprint ultérieur. */
export function APlusTard({ titre, sprint }: { titre: string; sprint: string }) {
  return (
    <Stack maw={1240}>
      <Title order={1} size={28}>
        {titre}
      </Title>
      <Card withBorder radius="lg" padding="lg">
        <Text c="dimmed">Écran prévu au {sprint} (voir docs/10-backlog-mvp.md).</Text>
      </Card>
    </Stack>
  );
}

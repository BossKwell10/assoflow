import type { Permission } from '@assoflow/contracts';
import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { useAuMoinsUnePermission } from './Si';

export function AccesRefuse() {
  return (
    <Stack maw={720}>
      <Title order={1} size={28}>
        {t('acces.refuseTitre')}
      </Title>
      <Card withBorder radius="lg" padding="lg">
        <Stack align="flex-start">
          <Text>{t('acces.refuseMessage')}</Text>
          <Button component={Link} to="/" variant="light">
            {t('acces.retourAccueil')}
          </Button>
        </Stack>
      </Card>
    </Stack>
  );
}

/** Garde de route : affiche « Accès refusé » si aucune des permissions n'est accordée. */
export function ExigerPermission({
  permission,
  children,
}: {
  permission: Permission | readonly Permission[];
  children: ReactNode;
}) {
  return useAuMoinsUnePermission(permission) ? children : <AccesRefuse />;
}

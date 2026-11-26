import { Card, Center, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { t } from '../../i18n';

/** Mise en page des écrans d'authentification (A0) : carte centrée sur fond clair. */
export function PageAuth({
  titre,
  sousTitre,
  largeur = 440,
  children,
}: {
  titre: string;
  sousTitre?: string;
  largeur?: number;
  children: ReactNode;
}) {
  return (
    <Center mih="100vh" p="md" bg="#F6F7F9" component="main">
      <Stack w="100%" maw={largeur} gap="lg">
        <Group gap="xs" justify="center">
          <ThemeIcon size={36} radius="md" aria-hidden>
            A
          </ThemeIcon>
          <Text ff="heading" fw={700} size="xl">
            {t('app.nom')}
          </Text>
        </Group>
        <Card withBorder radius={12} padding="xl" style={{ borderColor: '#E3E6EA' }}>
          <Stack gap="md">
            <div>
              <Title order={1} size={24}>
                {titre}
              </Title>
              {sousTitre && (
                <Text c="dimmed" size="sm" mt={4}>
                  {sousTitre}
                </Text>
              )}
            </div>
            {children}
          </Stack>
        </Card>
      </Stack>
    </Center>
  );
}

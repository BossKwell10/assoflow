import { Card, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';

/** Index des paramètres (A27–A33) ; seul A30 est livré au sprint 1. */
export function Parametres() {
  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        {t('parametres.titre')}
      </Title>
      <Si permission={['utilisateur.lire', 'utilisateur.gerer']}>
        <UnstyledButton component={Link} to="/parametres/utilisateurs" maw={480}>
          <Card withBorder radius="lg" padding="lg">
            <Text fw={600}>{t('parametres.utilisateurs')}</Text>
            <Text size="sm" c="dimmed">
              {t('parametres.utilisateursDescription')}
            </Text>
          </Card>
        </UnstyledButton>
      </Si>
      <Text c="dimmed" size="sm">
        {t('parametres.aVenir')}
      </Text>
    </Stack>
  );
}

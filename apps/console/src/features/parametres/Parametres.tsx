import type { Permission } from '@assoflow/contracts';
import { Card, SimpleGrid, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { Si } from '../../auth/Si';
import { t, type CleTexte } from '../../i18n';

const ECRANS: {
  lien:
    | '/parametres/association'
    | '/parametres/exercices'
    | '/parametres/categories'
    | '/parametres/utilisateurs'
    | '/parametres/appareils';
  titre: CleTexte;
  description: CleTexte;
  permission: Permission[];
}[] = [
  {
    lien: '/parametres/association',
    titre: 'parametres.association',
    description: 'parametres.associationDescription',
    permission: ['association.modifier'],
  },
  {
    lien: '/parametres/exercices',
    titre: 'parametres.exercices',
    description: 'parametres.exercicesDescription',
    permission: ['exercice.gerer', 'exercice.cloturer'],
  },
  {
    lien: '/parametres/categories',
    titre: 'parametres.categories',
    description: 'parametres.categoriesDescription',
    permission: ['association.modifier'],
  },
  {
    lien: '/parametres/utilisateurs',
    titre: 'parametres.utilisateurs',
    description: 'parametres.utilisateursDescription',
    permission: ['utilisateur.lire', 'utilisateur.gerer'],
  },
  {
    lien: '/parametres/appareils',
    titre: 'parametres.appareils',
    description: 'parametres.appareilsDescription',
    permission: ['utilisateur.lire'],
  },
];

/** Index des paramètres (A27–A33) ; A31 et A33 arrivent aux sprints suivants. */
export function Parametres() {
  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        {t('parametres.titre')}
      </Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }} maw={960}>
        {ECRANS.map((e) => (
          <Si key={e.lien} permission={e.permission}>
            <UnstyledButton component={Link} to={e.lien}>
              <Card withBorder radius={12} padding="lg" h="100%" style={{ borderColor: '#E3E6EA' }}>
                <Text fw={600}>{t(e.titre)}</Text>
                <Text size="sm" c="dimmed">
                  {t(e.description)}
                </Text>
              </Card>
            </UnstyledButton>
          </Si>
        ))}
      </SimpleGrid>
      <Text c="dimmed" size="sm">
        {t('parametres.aVenir')}
      </Text>
    </Stack>
  );
}

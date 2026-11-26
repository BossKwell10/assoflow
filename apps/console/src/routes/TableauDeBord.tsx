import { Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { appelApi } from '../shared/api';
import { Montant } from '../shared/Montant';
import { Statut } from '../shared/Statut';

interface Sante {
  statut: 'ok' | 'degrade';
  dependances: { postgres: string };
}

/** A1 — sera branché sur GET /v1/tableau-de-bord (sprint 7). */
export function TableauDeBord() {
  const sante = useQuery({
    queryKey: ['sante'],
    queryFn: () => appelApi<Sante>('/health/ready'),
    retry: false,
  });

  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        Tableau de bord
      </Title>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {[
          ['Recettes de l’exercice', 0],
          ['Dépenses de l’exercice', 0],
          ['Solde total', 0],
        ].map(([libelle, valeur]) => (
          <Card key={libelle as string} withBorder radius="lg" padding="lg">
            <Text size="sm" c="dimmed">
              {libelle}
            </Text>
            <Montant valeur={valeur as number} size="xl" />
          </Card>
        ))}
        <Card withBorder radius="lg" padding="lg">
          <Text size="sm" c="dimmed">
            API
          </Text>
          <Group mt={6}>
            {sante.isPending && <Statut ton="neutre">Vérification…</Statut>}
            {sante.isError && <Statut ton="alerte">Injoignable</Statut>}
            {sante.data && (
              <Statut ton={sante.data.statut === 'ok' ? 'succes' : 'attente'}>
                {sante.data.statut === 'ok' ? 'Opérationnelle' : 'Dégradée'}
              </Statut>
            )}
          </Group>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

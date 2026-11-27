import { Alert, Group, Progress, Stack, Text } from '@mantine/core';
import { useGetTachesId } from '../api/generated/rapports/rapports';
import type { Tache } from '../api/generated/modeles';
import { t } from '../i18n';
import { messageErreur } from './erreurs';
import { BadgeStatut } from './Statut';

/** Intervalle d'interrogation d'une tâche (docs/08 §3 : toutes les 2 s). */
export const INTERVALLE_SUIVI_MS = 2000;

const finie = (tache?: Tache) => tache?.statut === 'terminee' || tache?.statut === 'echec';

/** Suit une tâche asynchrone jusqu'à `terminee` ou `echec` (docs/06 §7). */
export function useSuiviTache(id: string | undefined, intervalle = INTERVALLE_SUIVI_MS) {
  return useGetTachesId(id ?? '', {
    query: {
      enabled: Boolean(id),
      staleTime: 0,
      refetchInterval: (q) => (finie(q.state.data) ? false : intervalle),
    },
  });
}

/**
 * Avancement d'une tâche (`SuiviTache`, docs/08 §7) : statut, barre de progression, message d'échec.
 * L'appelant lit le résultat quand `statut = terminee`.
 */
export function SuiviTache({
  id,
  libelle,
  intervalle,
}: {
  id: string;
  libelle: string;
  intervalle?: number;
}) {
  const suivi = useSuiviTache(id, intervalle);
  if (suivi.isError) {
    return (
      <Alert color="red" role="alert">
        {messageErreur(suivi.error)}
      </Alert>
    );
  }
  const tache = suivi.data;
  const progression = tache?.statut === 'terminee' ? 100 : (tache?.progression ?? 0);
  return (
    <Stack gap={6} role="status" aria-live="polite">
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          {libelle}
        </Text>
        <BadgeStatut domaine="tache" valeur={tache?.statut ?? 'en_attente'} />
      </Group>
      <Progress
        value={progression}
        aria-label={t('taches.progression', { pct: progression })}
        animated={!finie(tache)}
        color={tache?.statut === 'echec' ? 'red' : undefined}
      />
      {tache?.statut === 'echec' && (
        <Alert color="red" role="alert">
          {tache.erreur ?? t('taches.echec')}
        </Alert>
      )}
    </Stack>
  );
}

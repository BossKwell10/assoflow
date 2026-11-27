import { Group, Progress, Text } from '@mantine/core';
import type { QueryClient } from '@tanstack/react-query';
import { useGetExercices } from '../../api/generated/association/association';
import type { Campagne } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { formatDate } from '../../shared/format';

export const TAILLE_PAGE = 50;

export const PERIODICITES = ['unique', 'mensuelle', 'trimestrielle', 'semestrielle', 'annuelle'] as const;
export const MOTIFS = ['projet', 'deces', 'evenement', 'autre'] as const;

export const libellePeriodicite = (p: string) =>
  t(`campagnes.periodicite_${p as (typeof PERIODICITES)[number]}`);
export const libelleType = (c: Pick<Campagne, 'type' | 'motif'>) =>
  c.type === 'exceptionnelle'
    ? `${t('campagnes.typeExceptionnelle')}${c.motif ? ` (${t(`campagnes.motif_${c.motif}`)})` : ''}`
    : t('campagnes.typeOrdinaire');
export const periodeCampagne = (c: Pick<Campagne, 'dateDebut' | 'dateFin'>) =>
  `${formatDate(c.dateDebut)} → ${formatDate(c.dateFin)}`;

/** « 62 % » ; `null` → tiret (rien d'échu, RG-RAP-002). */
export const formatTaux = (taux: number | null | undefined) =>
  taux === null || taux === undefined ? '—' : `${Math.round(taux * 100)} %`;

/** Taux de recouvrement : barre et valeur (jamais la couleur seule, docs/08 §2). */
export function BarreTaux({ taux, largeur = 120 }: { taux: number | null | undefined; largeur?: number }) {
  const pct = taux === null || taux === undefined ? 0 : Math.round(taux * 100);
  const couleur = pct >= 80 ? 'green' : pct >= 50 ? 'orange' : 'red';
  return (
    <Group gap={8} wrap="nowrap">
      <Progress
        value={pct}
        w={largeur}
        color={taux === null || taux === undefined ? 'gray' : couleur}
        aria-label={t('campagnes.tauxRecouvrement')}
      />
      <Text size="sm" fw={600}>
        {formatTaux(taux)}
      </Text>
    </Group>
  );
}

/** Exercices, l'ouvert en premier ; libellé d'un exercice par id. */
export function useExercicesCotisation() {
  const exercices = useGetExercices({ query: { staleTime: 5 * 60_000 } });
  const liste = [...(exercices.data ?? [])].sort((a, b) =>
    a.statut === b.statut ? b.dateDebut.localeCompare(a.dateDebut) : a.statut === 'ouvert' ? -1 : 1,
  );
  const parId = new Map(liste.map((e) => [e.id ?? '', e]));
  return { liste, exercice: (id?: string) => (id ? parId.get(id) : undefined) };
}

/** Invalide campagnes, échéances et situations de membres après une écriture. */
export const invaliderCotisations = (client: QueryClient) =>
  client.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === 'string' &&
      (q.queryKey[0].startsWith('/campagnes') ||
        q.queryKey[0].startsWith('/echeances') ||
        q.queryKey[0].startsWith('/membres')),
  });

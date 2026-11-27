import { Anchor, Button, Card, Group, NativeSelect, SimpleGrid, Stack, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useGetCampagnes } from '../../api/generated/cotisations/cotisations';
import type { Campagne, GetCampagnesParams } from '../../api/generated/modeles';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';
import { Montant } from '../../shared/Montant';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { BadgeStatut } from '../../shared/Statut';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import {
  BarreTaux,
  libellePeriodicite,
  libelleType,
  periodeCampagne,
  TAILLE_PAGE,
  useExercicesCotisation,
} from './commun';
import type { RechercheCampagnes } from './recherche';

/** A8 — Campagnes (RF-030, RF-037). */
export function ListeCampagnes() {
  const { recherche, modifier, curseur, pagination } = useRechercheTableau<RechercheCampagnes>();
  const exercices = useExercicesCotisation();
  const parametres = Object.fromEntries(
    Object.entries({
      exerciceId: recherche.exerciceId,
      statut: recherche.statut,
      type: recherche.type,
      limite: TAILLE_PAGE,
      curseur,
    }).filter(([, v]) => v !== undefined),
  ) as GetCampagnesParams;
  const liste = useGetCampagnes(parametres);

  const colonnes: Colonne<Campagne>[] = [
    {
      cle: 'libelle',
      titre: t('campagnes.colLibelle'),
      rendu: (c) => (
        <Anchor component={Link} to={`/cotisations/campagnes/${c.id}`} fw={500}>
          {c.libelle}
        </Anchor>
      ),
    },
    { cle: 'type', titre: t('campagnes.colType'), rendu: (c) => libelleType(c) },
    {
      cle: 'montant',
      titre: t('campagnes.colMontant'),
      rendu: (c) => <Montant valeur={c.montant} size="sm" />,
    },
    {
      cle: 'periodicite',
      titre: t('campagnes.colPeriodicite'),
      rendu: (c) => libellePeriodicite(c.periodicite),
    },
    { cle: 'periode', titre: t('campagnes.colPeriode'), rendu: (c) => periodeCampagne(c) },
    {
      cle: 'statut',
      titre: t('campagnes.colStatut'),
      rendu: (c) => <BadgeStatut domaine="campagne" valeur={c.statut} />,
    },
    { cle: 'taux', titre: t('campagnes.colTaux'), rendu: (c) => <BarreTaux taux={c.tauxRecouvrement} /> },
  ];

  return (
    <Stack gap="lg" maw={1240}>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('campagnes.titre')}
        </Title>
        <Group gap="sm">
          <Button component={Link} to="/cotisations/echeances" variant="default">
            {t('echeances.titre')}
          </Button>
          <Si permission="cotisation.gerer">
            <Button component={Link} to="/cotisations/campagnes/nouvelle">
              {t('campagnes.nouvelle')}
            </Button>
          </Si>
        </Group>
      </Group>
      <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NativeSelect
            label={t('campagnes.filtreExercice')}
            value={recherche.exerciceId ?? ''}
            onChange={(e) => modifier({ exerciceId: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              ...exercices.liste.map((e) => ({ value: e.id ?? '', label: e.libelle })),
            ]}
          />
          <NativeSelect
            label={t('campagnes.filtreStatut')}
            value={recherche.statut ?? ''}
            onChange={(e) => modifier({ statut: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              { value: 'brouillon', label: t('campagnes.statutBrouillon') },
              { value: 'active', label: t('campagnes.statutActive') },
              { value: 'cloturee', label: t('campagnes.statutCloturee') },
            ]}
          />
          <NativeSelect
            label={t('campagnes.filtreType')}
            value={recherche.type ?? ''}
            onChange={(e) => modifier({ type: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              { value: 'ordinaire', label: t('campagnes.typeOrdinaire') },
              { value: 'exceptionnelle', label: t('campagnes.typeExceptionnelle') },
            ]}
          />
        </SimpleGrid>
      </Card>
      <TableauDonnees
        libelle={t('campagnes.titre')}
        colonnes={colonnes}
        lignes={liste.data?.donnees}
        cleLigne={(c) => c.id ?? c.libelle}
        chargement={liste.isPending}
        erreur={liste.error}
        pagination={{ ...pagination, curseurSuivant: liste.data?.page.curseurSuivant }}
        messageVide={t('campagnes.aucune')}
      />
    </Stack>
  );
}

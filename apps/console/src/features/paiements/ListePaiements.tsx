import { LIBELLES_MODES_PAIEMENT, MODES_PAIEMENT } from '@assoflow/contracts';
import {
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  NativeSelect,
  SimpleGrid,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useGetCampagnes, useGetPaiements } from '../../api/generated/cotisations/cotisations';
import type { GetPaiementsParams } from '../../api/generated/modeles';
import { useGetComptes } from '../../api/generated/tresorerie/tresorerie';
import { Si, useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { TableauPaiements, TAILLE_PAGE } from './commun';
import type { RecherchePaiements } from './recherche';

/** A11 — Paiements : liste filtrable, détail, reçu, renvoi, annulation (RF-032, RF-033, RF-046). */
export function ListePaiements() {
  const { recherche, modifier, curseur, pagination } = useRechercheTableau<RecherchePaiements>();
  const lectureComptes = useAuMoinsUnePermission('tresorerie.lire');
  const comptes = useGetComptes({ query: { enabled: lectureComptes, staleTime: 60_000 } });
  const campagnes = useGetCampagnes({ limite: 200 }, { query: { staleTime: 60_000 } });
  const parametres = Object.fromEntries(
    Object.entries({
      du: recherche.du,
      au: recherche.au,
      mode: recherche.mode,
      compteId: recherche.compteId,
      campagneId: recherche.campagneId,
      inclureAnnules: recherche.inclureAnnules,
      limite: TAILLE_PAGE,
      curseur,
    }).filter(([, v]) => v !== undefined),
  ) as GetPaiementsParams;
  const liste = useGetPaiements(parametres);

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/cotisations/campagnes" size="sm">
        ← {t('campagnes.retourListe')}
      </Anchor>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('paiements.titre')}
        </Title>
        <Si permission="paiement.enregistrer">
          <Button component={Link} to="/cotisations/paiements/saisie">
            {t('paiements.saisir')}
          </Button>
        </Si>
      </Group>
      <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          <TextInput
            type="date"
            label={t('paiements.du')}
            value={recherche.du ?? ''}
            onChange={(e) => modifier({ du: e.currentTarget.value || undefined })}
          />
          <TextInput
            type="date"
            label={t('paiements.au')}
            value={recherche.au ?? ''}
            onChange={(e) => modifier({ au: e.currentTarget.value || undefined })}
          />
          <NativeSelect
            label={t('paiements.filtreMode')}
            value={recherche.mode ?? ''}
            onChange={(e) => modifier({ mode: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              ...MODES_PAIEMENT.map((m) => ({ value: m, label: LIBELLES_MODES_PAIEMENT[m] })),
            ]}
          />
          {lectureComptes && (
            <NativeSelect
              label={t('paiements.filtreCompte')}
              value={recherche.compteId ?? ''}
              onChange={(e) => modifier({ compteId: e.currentTarget.value || undefined })}
              data={[
                { value: '', label: t('campagnes.tous') },
                ...(comptes.data ?? []).map((c) => ({ value: c.id ?? '', label: c.libelle })),
              ]}
            />
          )}
          <NativeSelect
            label={t('paiements.filtreCampagne')}
            value={recherche.campagneId ?? ''}
            onChange={(e) => modifier({ campagneId: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              ...(campagnes.data?.donnees ?? [])
                .filter((c) => c.statut !== 'brouillon')
                .map((c) => ({ value: c.id ?? '', label: c.libelle })),
            ]}
          />
          <Checkbox
            mt="xl"
            label={t('paiements.inclureAnnules')}
            checked={recherche.inclureAnnules ?? false}
            onChange={(e) => modifier({ inclureAnnules: e.currentTarget.checked || undefined })}
          />
        </SimpleGrid>
      </Card>
      <TableauPaiements
        libelle={t('paiements.titre')}
        lignes={liste.data?.donnees}
        chargement={liste.isPending}
        erreur={liste.error}
        pagination={{ ...pagination, curseurSuivant: liste.data?.page.curseurSuivant }}
      />
    </Stack>
  );
}

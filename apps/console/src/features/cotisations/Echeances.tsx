import {
  Anchor,
  Button,
  Card,
  Group,
  NativeSelect,
  SimpleGrid,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useGetCampagnes, useGetEcheances } from '../../api/generated/cotisations/cotisations';
import type { Echeance, GetEcheancesParams } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { telechargerFichier, versCsv } from '../../shared/csv';
import { formatDate } from '../../shared/format';
import { Montant } from '../../shared/Montant';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { BadgeStatut } from '../../shared/Statut';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import { TAILLE_PAGE } from './commun';
import type { RechercheEcheances } from './recherche';

const SITUATIONS = ['a_venir', 'partielle', 'payee', 'en_retard', 'exoneree'] as const;

/** A10 — Échéances : vue transversale filtrable (RF-031, RF-035). */
export function Echeances() {
  const { recherche, modifier, curseur, pagination } = useRechercheTableau<RechercheEcheances>();
  const campagnes = useGetCampagnes({ limite: 200 }, { query: { staleTime: 60_000 } });
  const parametres = Object.fromEntries(
    Object.entries({
      campagneId: recherche.campagneId,
      situation: recherche.situation,
      du: recherche.du,
      au: recherche.au,
      membreId: recherche.membreId,
      limite: TAILLE_PAGE,
      curseur,
    }).filter(([, v]) => v !== undefined),
  ) as GetEcheancesParams;
  const liste = useGetEcheances(parametres);

  const colonnes: Colonne<Echeance>[] = [
    { cle: 'date', titre: t('echeances.colDate'), rendu: (e) => formatDate(e.dateEcheance) },
    {
      cle: 'membre',
      titre: t('echeances.colMembre'),
      rendu: (e) => (
        <Anchor component={Link} to={`/membres/${e.membreId}`}>
          {e.membreNumero} — {e.membreNom}
        </Anchor>
      ),
    },
    {
      cle: 'campagne',
      titre: t('echeances.colCampagne'),
      rendu: (e) => (
        <Anchor component={Link} to={`/cotisations/campagnes/${e.campagneId}`}>
          {e.campagneLibelle}
        </Anchor>
      ),
    },
    { cle: 'periode', titre: t('echeances.colPeriode'), rendu: (e) => e.libellePeriode },
    { cle: 'du', titre: t('echeances.colDu'), rendu: (e) => <Montant valeur={e.montantDu} size="sm" /> },
    {
      cle: 'paye',
      titre: t('echeances.colPaye'),
      rendu: (e) => <Montant valeur={e.montantPaye} size="sm" />,
    },
    {
      cle: 'situation',
      titre: t('echeances.colSituation'),
      rendu: (e) => <BadgeStatut domaine="echeance" valeur={e.situation} />,
    },
  ];

  const exporter = (lignes: readonly Echeance[]) =>
    telechargerFichier(
      'echeances.csv',
      versCsv<Echeance>(
        [
          { titre: t('echeances.colDate'), valeur: (e) => formatDate(e.dateEcheance) },
          { titre: t('echeances.colNumero'), valeur: (e) => e.membreNumero },
          { titre: t('echeances.colMembre'), valeur: (e) => e.membreNom },
          { titre: t('echeances.colCampagne'), valeur: (e) => e.campagneLibelle },
          { titre: t('echeances.colPeriode'), valeur: (e) => e.libellePeriode },
          { titre: t('echeances.colDu'), valeur: (e) => e.montantDu },
          { titre: t('echeances.colPaye'), valeur: (e) => e.montantPaye },
          { titre: t('echeances.colSituation'), valeur: (e) => t(`echeances.situation_${e.situation}`) },
        ],
        lignes,
      ),
    );

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/cotisations/campagnes" size="sm">
        ← {t('campagnes.retourListe')}
      </Anchor>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('echeances.titre')}
        </Title>
        <Button variant="default" onClick={() => exporter(liste.data?.donnees ?? [])}>
          {t('echeances.exporterPage')}
        </Button>
      </Group>
      <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <NativeSelect
            label={t('echeances.filtreCampagne')}
            value={recherche.campagneId ?? ''}
            onChange={(e) => modifier({ campagneId: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              ...(campagnes.data?.donnees ?? [])
                .filter((c) => c.statut !== 'brouillon')
                .map((c) => ({ value: c.id ?? '', label: c.libelle })),
            ]}
          />
          <NativeSelect
            label={t('echeances.filtreSituation')}
            value={recherche.situation ?? ''}
            onChange={(e) => modifier({ situation: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              ...SITUATIONS.map((s) => ({ value: s, label: t(`echeances.situation_${s}`) })),
            ]}
          />
          <TextInput
            type="date"
            label={t('echeances.du')}
            value={recherche.du ?? ''}
            onChange={(e) => modifier({ du: e.currentTarget.value || undefined })}
          />
          <TextInput
            type="date"
            label={t('echeances.au')}
            value={recherche.au ?? ''}
            onChange={(e) => modifier({ au: e.currentTarget.value || undefined })}
          />
        </SimpleGrid>
      </Card>
      <TableauDonnees
        libelle={t('echeances.titre')}
        colonnes={colonnes}
        lignes={liste.data?.donnees}
        cleLigne={(e) => e.id}
        chargement={liste.isPending}
        erreur={liste.error}
        pagination={{ ...pagination, curseurSuivant: liste.data?.page.curseurSuivant }}
        actionsSelection={(selection) => (
          <Button size="xs" variant="default" onClick={() => exporter(selection)}>
            {t('echeances.exporterSelection')}
          </Button>
        )}
      />
    </Stack>
  );
}

import {
  CODES_MODELES,
  definirStatut,
  estCodeModele,
  MODELES_NOTIFICATION,
  STATUTS_NOTIFICATION,
} from '@assoflow/contracts';
import { Anchor, Card, Group, NativeSelect, Progress, SimpleGrid, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useGetNotifications, useGetSmsConsommation } from '../../api/generated/communication/communication';
import type {
  GetNotificationsParams,
  GetNotificationsStatut,
  Notification,
} from '../../api/generated/modeles';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { formatDateHeure } from '../../shared/format';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { BadgeStatut } from '../../shared/Statut';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import type { RechercheCommunication } from './recherche';

const libelleModele = (code: string) => (estCodeModele(code) ? MODELES_NOTIFICATION[code].libelle : code);

/** Consommation SMS du mois (RF-SUP-031) : jauge, unités, messages hors quota. */
export function JaugeSms() {
  const lecture = useAuMoinsUnePermission('association.lire');
  const conso = useGetSmsConsommation({ query: { enabled: lecture } });
  if (!lecture || !conso.data) return null;
  const c = conso.data;
  const couleur = c.pourcentage >= 100 ? 'red' : c.pourcentage >= 80 ? 'orange' : 'teal';
  return (
    <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
      <Stack gap={6}>
        <Group justify="space-between">
          <Text fw={600}>{t('communication.consommation')}</Text>
          <Text size="sm">
            {t('communication.consommationDetail', {
              unites: c.unites,
              quota: c.quota,
              pourcentage: c.pourcentage,
            })}
          </Text>
        </Group>
        <Progress
          value={Math.min(c.pourcentage, 100)}
          color={couleur}
          aria-label={t('communication.consommation')}
        />
        {c.horsQuota > 0 && (
          <Text size="sm" c="#A11B1B">
            {t('communication.horsQuota', { n: c.horsQuota })}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/** A22 — Historique des envois (statuts, destinataires masqués, relais par le chef de famille). */
export function Historique() {
  const { recherche, modifier, curseur, pagination } = useRechercheTableau<RechercheCommunication>();
  const parametres = Object.fromEntries(
    Object.entries({
      statut: recherche.statut,
      modele: recherche.modele,
      membreId: recherche.membreId,
      limite: 50,
      curseur,
    }).filter(([, v]) => v !== undefined),
  ) as GetNotificationsParams;
  const liste = useGetNotifications(parametres);

  const colonnes: Colonne<Notification>[] = [
    { cle: 'date', titre: t('communication.colDate'), rendu: (n) => formatDateHeure(n.createdAt) },
    {
      cle: 'membre',
      titre: t('communication.colMembre'),
      rendu: (n) =>
        n.membreId ? (
          <Stack gap={0}>
            <Anchor component={Link} to={`/membres/${n.membreId}`} size="sm">
              {n.membreNom}
            </Anchor>
            {n.relaisFamille && (
              <Text size="xs" c="dimmed">
                {t('communication.relaisFamille')}
              </Text>
            )}
          </Stack>
        ) : (
          '—'
        ),
    },
    { cle: 'modele', titre: t('communication.colModele'), rendu: (n) => libelleModele(n.modeleCode) },
    { cle: 'destinataire', titre: t('communication.colDestinataire'), rendu: (n) => n.destinataireMasque },
    {
      cle: 'statut',
      titre: t('communication.colStatut'),
      rendu: (n) => (
        <Stack gap={0}>
          <BadgeStatut domaine="notification" valeur={n.statut} />
          {n.derniereErreur && (
            <Text size="xs" c="dimmed">
              {n.derniereErreur}
            </Text>
          )}
        </Stack>
      ),
    },
    { cle: 'unites', titre: t('communication.colUnites'), rendu: (n) => n.unites },
    {
      cle: 'contenu',
      titre: t('communication.colContenu'),
      rendu: (n) => <Text size="xs">{n.contenu}</Text>,
    },
  ];

  return (
    <Stack gap="lg">
      <JaugeSms />
      <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NativeSelect
            label={t('communication.filtreStatut')}
            value={recherche.statut ?? ''}
            onChange={(e) =>
              modifier({ statut: (e.currentTarget.value || undefined) as GetNotificationsStatut })
            }
            data={[
              { value: '', label: t('campagnes.tous') },
              ...STATUTS_NOTIFICATION.map((s) => ({
                value: s,
                label: definirStatut('notification', s).libelle,
              })),
            ]}
          />
          <NativeSelect
            label={t('communication.filtreModele')}
            value={recherche.modele ?? ''}
            onChange={(e) => modifier({ modele: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('campagnes.tous') },
              ...CODES_MODELES.map((c) => ({ value: c, label: libelleModele(c) })),
            ]}
          />
        </SimpleGrid>
      </Card>
      <TableauDonnees
        libelle={t('communication.ongletHistorique')}
        colonnes={colonnes}
        lignes={liste.data?.donnees}
        cleLigne={(n) => n.id}
        chargement={liste.isPending}
        erreur={liste.error}
        pagination={{ ...pagination, curseurSuivant: liste.data?.page.curseurSuivant }}
        messageVide={t('communication.aucunEnvoi')}
      />
    </Stack>
  );
}

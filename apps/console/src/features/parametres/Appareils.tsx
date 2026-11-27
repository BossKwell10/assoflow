import { Anchor, Button, Card, Checkbox, Group, NativeSelect, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Appareil, GetSyncRejetsParams, RejetSync } from '../../api/generated/modeles';
import {
  getGetAppareilsQueryKey,
  getGetSyncRejetsQueryKey,
  useGetAppareils,
  useGetSyncRejets,
  usePostAppareilsIdRevoquer,
} from '../../api/generated/synchronisation/synchronisation';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { formatDateHeure } from '../../shared/format';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { BadgeStatut, Statut } from '../../shared/Statut';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import type { RechercheAppareils } from './rechercheAppareils';

const PLATEFORMES: Record<string, string> = { android: 'Android', ios: 'iOS', web: 'Web' };

/**
 * A32 — Appareils (RF-SUP-033, RF-ADM-014) : appareils enregistrés et état de leur synchronisation,
 * révocation (avec purge), rejets de synchronisation par appareil (l'acquittement se fait sur l'appareil).
 */
export function Appareils() {
  const { recherche, modifier, curseur, pagination } = useRechercheTableau<RechercheAppareils>();
  const appareils = useGetAppareils();
  const [aRevoquer, setARevoquer] = useState<Appareil>();
  const [purger, setPurger] = useState(false);
  const client = useQueryClient();
  const revoquer = usePostAppareilsIdRevoquer();

  const parametresRejets = Object.fromEntries(
    Object.entries({
      appareilId: recherche.appareilId,
      inclureAcquittes: recherche.inclureAcquittes || undefined,
      limite: 50,
      curseur,
    }).filter(([, v]) => v !== undefined),
  ) as GetSyncRejetsParams;
  const rejets = useGetSyncRejets(parametresRejets);

  const colonnes: Colonne<Appareil>[] = [
    { cle: 'utilisateur', titre: t('appareils.colUtilisateur'), rendu: (a) => a.utilisateur.nom ?? '—' },
    {
      cle: 'appareil',
      titre: t('appareils.colAppareil'),
      rendu: (a) => (
        <Stack gap={0}>
          <Text size="sm">{a.nom}</Text>
          <Text size="xs" c="dimmed">
            {PLATEFORMES[a.plateforme] ?? a.plateforme}
          </Text>
        </Stack>
      ),
    },
    { cle: 'version', titre: t('appareils.colVersion'), rendu: (a) => a.versionApp },
    { cle: 'prefixe', titre: t('appareils.colPrefixe'), rendu: (a) => a.prefixeRecu },
    {
      cle: 'sync',
      titre: t('appareils.colDerniereSync'),
      rendu: (a) => (a.derniereSync ? formatDateHeure(a.derniereSync) : t('appareils.jamais')),
    },
    {
      cle: 'attente',
      titre: t('appareils.colEnAttente'),
      rendu: (a) => (a.elementsEnAttente === null ? '—' : a.elementsEnAttente),
    },
    {
      cle: 'rejets',
      titre: t('appareils.colRejets'),
      rendu: (a) =>
        a.rejetsNonAcquittes > 0 ? (
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => modifier({ appareilId: a.id })}
            aria-label={t('appareils.voirRejets', { nom: a.nom, n: a.rejetsNonAcquittes })}
          >
            <Statut ton="alerte">{t('appareils.rejetsNombre', { n: a.rejetsNonAcquittes })}</Statut>
          </Anchor>
        ) : (
          '0'
        ),
    },
    {
      cle: 'statut',
      titre: t('appareils.colStatut'),
      rendu: (a) => (
        <Stack gap={2}>
          <BadgeStatut domaine="appareil" valeur={a.revoqueAt ? 'revoque' : 'actif'} />
          {a.purgeDemandee && (
            <Text size="xs" c="dimmed">
              {t('appareils.purgeDemandee')}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      cle: 'actions',
      titre: t('appareils.colActions'),
      rendu: (a) =>
        a.revoqueAt ? null : (
          <Si permission="utilisateur.gerer">
            <Button
              size="xs"
              variant="light"
              color="red"
              onClick={() => {
                setPurger(false);
                setARevoquer(a);
              }}
              aria-label={t('appareils.revoquerAppareil', { nom: a.nom })}
            >
              {t('appareils.revoquer')}
            </Button>
          </Si>
        ),
    },
  ];

  const colonnesRejets: Colonne<RejetSync>[] = [
    { cle: 'date', titre: t('appareils.colDate'), rendu: (r) => formatDateHeure(r.createdAt) },
    { cle: 'appareil', titre: t('appareils.colAppareil'), rendu: (r) => r.appareilNom },
    { cle: 'table', titre: t('appareils.colTable'), rendu: (r) => r.table },
    {
      cle: 'element',
      titre: t('appareils.colElement'),
      rendu: (r) => (
        <Text size="xs" ff="monospace">
          {r.elementId}
        </Text>
      ),
    },
    { cle: 'code', titre: t('appareils.colCode'), rendu: (r) => r.code },
    { cle: 'message', titre: t('appareils.colMessage'), rendu: (r) => <Text size="sm">{r.message}</Text> },
    {
      cle: 'statut',
      titre: t('appareils.colStatut'),
      rendu: (r) => <BadgeStatut domaine="rejetSync" valeur={r.acquitteAt ? 'acquitte' : 'a_corriger'} />,
    },
  ];

  return (
    <Stack gap="lg" maw={1240}>
      <Title order={1} size={28}>
        {t('appareils.titre')}
      </Title>
      <Text c="dimmed">{t('appareils.description')}</Text>
      <TableauDonnees
        libelle={t('appareils.titre')}
        colonnes={colonnes}
        lignes={appareils.data}
        cleLigne={(a) => a.id}
        chargement={appareils.isPending}
        erreur={appareils.error}
        messageVide={t('appareils.aucun')}
      />

      <Title order={2} size={20}>
        {t('appareils.rejetsTitre')}
      </Title>
      <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
        <Group align="flex-end">
          <NativeSelect
            label={t('appareils.filtreAppareil')}
            value={recherche.appareilId ?? ''}
            onChange={(e) => modifier({ appareilId: e.currentTarget.value || undefined })}
            data={[
              { value: '', label: t('appareils.tousAppareils') },
              ...(appareils.data ?? []).map((a) => ({
                value: a.id,
                label: `${a.nom} (${a.prefixeRecu}) — ${a.utilisateur.nom ?? ''}`,
              })),
            ]}
          />
          <Checkbox
            label={t('appareils.inclureAcquittes')}
            checked={recherche.inclureAcquittes ?? false}
            onChange={(e) => modifier({ inclureAcquittes: e.currentTarget.checked || undefined })}
          />
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          {t('appareils.rejetsAide')}
        </Text>
      </Card>
      <TableauDonnees
        libelle={t('appareils.rejetsTitre')}
        colonnes={colonnesRejets}
        lignes={rejets.data?.donnees}
        cleLigne={(r) => r.id}
        chargement={rejets.isPending}
        erreur={rejets.error}
        pagination={{ ...pagination, curseurSuivant: rejets.data?.page.curseurSuivant }}
        messageVide={t('appareils.aucunRejet')}
      />

      <ConfirmationAction
        ouvert={aRevoquer !== undefined}
        onFermer={() => setARevoquer(undefined)}
        titre={t('appareils.revoquerTitre')}
        danger
        motifRequis
        libelleConfirmer={t('appareils.revoquer')}
        resume={
          aRevoquer
            ? t('appareils.revoquerResume', {
                nom: aRevoquer.nom,
                utilisateur: aRevoquer.utilisateur.nom ?? '',
                prefixe: aRevoquer.prefixeRecu,
              })
            : ''
        }
        complement={
          <Checkbox
            label={t('appareils.purger')}
            description={t('appareils.purgerAide')}
            checked={purger}
            onChange={(e) => setPurger(e.currentTarget.checked)}
          />
        }
        onConfirmer={async (motif) => {
          await revoquer.mutateAsync({ id: aRevoquer!.id, data: { motif: motif!, purger } });
          await Promise.all([
            client.invalidateQueries({ queryKey: getGetAppareilsQueryKey() }),
            client.invalidateQueries({ queryKey: getGetSyncRejetsQueryKey() }),
          ]);
        }}
      />
    </Stack>
  );
}

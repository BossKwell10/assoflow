import { Alert, Anchor, Button, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  postMembresIdDesactiver,
  postMembresIdDoublon,
  useGetMembresDoublons,
} from '../../api/generated/membres/membres';
import type { Membre } from '../../api/generated/modeles';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { messageErreur } from '../../shared/erreurs';
import { formatDate } from '../../shared/format';
import { BadgeStatut } from '../../shared/Statut';
import {
  Chargement,
  invaliderMembres,
  nomMembre,
  useAffichageTelephone,
  useReferentielsMembres,
} from './commun';

const normaliser = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Regroupe les membres suspects selon RG-MBR-003 (mêmes nom + prénoms, ou même téléphone).
 * Le contrat renvoie une liste à plat, sans la paire d'origine (écart signalé).
 */
export function regrouperDoublons(membres: readonly Membre[]): Membre[][] {
  const groupes: Membre[][] = [];
  const cle = (m: Membre) => [normaliser(nomMembre(m)), m.telephone ?? ''];
  for (const m of membres) {
    const [nom, tel] = cle(m);
    const groupe = groupes.find((g) =>
      g.some((autre) => {
        const [n, tl] = cle(autre);
        return n === nom || (tel !== '' && tl === tel);
      }),
    );
    if (groupe) groupe.push(m);
    else groupes.push([m]);
  }
  return groupes;
}

type Action = { type: 'pasDoublon' | 'desactiver'; membre: Membre };

/** A7 — Doublons probables (RG-MBR-003) : pas de fusion automatique au MVP. */
export function Doublons() {
  const client = useQueryClient();
  const doublons = useGetMembresDoublons();
  const telephone = useAffichageTelephone();
  const ref = useReferentielsMembres();
  const peutModifier = useAuMoinsUnePermission('membre.modifier');
  const peutDesactiver = useAuMoinsUnePermission('membre.suspendre');
  const [action, setAction] = useState<Action>();
  const [succes, setSucces] = useState<string>();

  if (doublons.isPending) return <Chargement />;
  if (doublons.isError)
    return (
      <Alert color="red" role="alert" maw={720}>
        {messageErreur(doublons.error)}
      </Alert>
    );
  const groupes = regrouperDoublons(doublons.data);

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/membres" size="sm">
        ← {t('membres.retourListe')}
      </Anchor>
      <Title order={1} size={28}>
        {t('doublons.titre')}
      </Title>
      <Text c="dimmed">{t('doublons.intro')}</Text>
      <div role="status" aria-live="polite">
        {succes && (
          <Text c="#1B6B34" size="sm">
            {succes}
          </Text>
        )}
      </div>
      {groupes.length === 0 && <Text c="dimmed">{t('doublons.aucun')}</Text>}
      {groupes.map((groupe) => (
        <Card
          key={groupe.map((m) => m.id).join('-')}
          withBorder
          radius={12}
          padding="lg"
          style={{ borderColor: '#E3E6EA' }}
          role="group"
          aria-label={t('doublons.groupe', { nom: nomMembre(groupe[0]!) })}
        >
          <SimpleGrid cols={{ base: 1, md: Math.min(groupe.length, 3) }}>
            {groupe.map((m) => (
              <Stack key={m.id} gap={6} p="sm" style={{ border: '1px solid #E3E6EA', borderRadius: 12 }}>
                <Anchor component={Link} to={`/membres/${m.id}`} fw={600}>
                  {nomMembre(m)}
                </Anchor>
                <Text size="sm" c="dimmed">
                  {m.numero}
                </Text>
                <Group gap={6}>
                  <BadgeStatut domaine="membreEtat" valeur={m.etat} />
                </Group>
                <Text size="sm">
                  {t('membres.colTelephone')} : {telephone(m.telephone)}
                </Text>
                <Text size="sm">
                  {t('membres.dateNaissance')} : {formatDate(m.dateNaissance) || '—'}
                </Text>
                <Text size="sm">
                  {t('membres.colFamille')} : {ref.famille(m.familleId)?.nom ?? '—'}
                </Text>
                <Text size="sm">
                  {t('membres.dateAdhesion')} : {formatDate(m.dateAdhesion) || '—'}
                </Text>
                <Group gap="xs" mt="xs">
                  {peutModifier && (
                    <Button
                      size="xs"
                      variant="default"
                      mih={36}
                      aria-label={t('doublons.pasDoublonAria', { nom: nomMembre(m) })}
                      onClick={() => setAction({ type: 'pasDoublon', membre: m })}
                    >
                      {t('doublons.pasDoublon')}
                    </Button>
                  )}
                  {peutDesactiver && m.etat !== 'desactive' && (
                    <Button
                      size="xs"
                      variant="outline"
                      color="red.9"
                      mih={36}
                      aria-label={t('doublons.desactiverAria', { nom: nomMembre(m) })}
                      onClick={() => setAction({ type: 'desactiver', membre: m })}
                    >
                      {t('doublons.desactiver')}
                    </Button>
                  )}
                </Group>
              </Stack>
            ))}
          </SimpleGrid>
        </Card>
      ))}

      <ConfirmationAction
        ouvert={action?.type === 'pasDoublon'}
        onFermer={() => setAction(undefined)}
        titre={t('doublons.pasDoublonTitre')}
        resume={action && t('doublons.pasDoublonResume', { nom: nomMembre(action.membre) })}
        libelleConfirmer={t('commun.confirmer')}
        onConfirmer={async () => {
          if (!action) return;
          await postMembresIdDoublon(action.membre.id, { decision: 'pas_doublon' });
          setSucces(t('doublons.pasDoublonOk', { nom: nomMembre(action.membre) }));
          await invaliderMembres(client);
        }}
      />
      <ConfirmationAction
        ouvert={action?.type === 'desactiver'}
        onFermer={() => setAction(undefined)}
        titre={t('membres.desactivationTitre')}
        resume={action && t('membres.desactivationResume', { nom: nomMembre(action.membre) })}
        libelleConfirmer={t('membres.desactiver')}
        motifRequis
        danger
        onConfirmer={async (motif) => {
          if (!action || !motif) return;
          await postMembresIdDesactiver(action.membre.id, { motif });
          setSucces(t('membres.desactivationOk', { nom: nomMembre(action.membre) }));
          await invaliderMembres(client);
        }}
      />
    </Stack>
  );
}

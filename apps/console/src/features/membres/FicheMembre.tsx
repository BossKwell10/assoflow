import {
  Alert,
  Anchor,
  Avatar,
  Button,
  Card,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  getGetMembresIdQueryKey,
  getMembresIdCarte,
  postMembresIdAnonymiser,
  postMembresIdDesactiver,
  postMembresIdReactiver,
  postMembresIdSuspendre,
  useGetMembresId,
  useGetMembresIdSituation,
} from '../../api/generated/membres/membres';
import type { Membre } from '../../api/generated/modeles';
import { useAuMoinsUnePermission, Si } from '../../auth/Si';
import { t } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { telechargerBlob } from '../../shared/csv';
import { messageErreur } from '../../shared/erreurs';
import { Montant } from '../../shared/Montant';
import { BadgeStatut, Statut } from '../../shared/Statut';
import { AyantsDroit } from './AyantsDroit';
import {
  Bientot,
  Chargement,
  invaliderMembres,
  nomMembre,
  nomPays,
  useAffichageTelephone,
  useReferentielsMembres,
} from './commun';
import { PaiementsMembre } from '../paiements/PaiementsMembre';
import { HistoriqueMembre, InformationsMembre, SituationMembre } from './OngletsFiche';

type Action = 'suspendre' | 'reactiver' | 'desactiver' | 'anonymiser';

const initiales = (m: Membre) => `${m.prenoms.charAt(0)}${m.nom.charAt(0)}`.toUpperCase();

/** A3 — Fiche membre (RF-026, RF-035, RF-028). */
export function FicheMembre() {
  const { id } = useParams({ strict: false }) as { id: string };
  const client = useQueryClient();
  const membre = useGetMembresId(id);
  const situation = useGetMembresIdSituation(id);
  const telephone = useAffichageTelephone();
  const ref = useReferentielsMembres();
  const peutChangerEtat = useAuMoinsUnePermission('membre.suspendre');
  const peutAnonymiser = useAuMoinsUnePermission('membre.anonymiser');
  const [action, setAction] = useState<Action>();
  const [succes, setSucces] = useState<string>();
  const [carteEnCours, setCarteEnCours] = useState(false);
  const [erreurCarte, setErreurCarte] = useState<string>();

  if (membre.isPending) return <Chargement />;
  if (membre.isError)
    return (
      <Alert color="red" role="alert" maw={720}>
        {messageErreur(membre.error)}
      </Alert>
    );

  const m = membre.data;
  const nom = nomMembre(m);
  const ouvrirCarte = async () => {
    setCarteEnCours(true);
    setErreurCarte(undefined);
    try {
      telechargerBlob(`carte-${m.numero ?? m.id}.pdf`, await getMembresIdCarte(id));
    } catch (e) {
      setErreurCarte(messageErreur(e));
    } finally {
      setCarteEnCours(false);
    }
  };
  const famille = ref.famille(m.familleId);
  const apres = async (maj: Membre, message: string) => {
    client.setQueryData(getGetMembresIdQueryKey(id), maj);
    setSucces(message);
    await invaliderMembres(client);
  };

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/membres" size="sm">
        ← {t('membres.retourListe')}
      </Anchor>

      <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group align="flex-start" wrap="nowrap">
            <Avatar src={m.photoUrl ?? undefined} size={72} radius="xl" color="accent" alt="">
              {initiales(m)}
            </Avatar>
            <Stack gap={4}>
              <Title order={1} size={26}>
                {nom}
              </Title>
              <Text c="dimmed" size="sm">
                {m.numero ?? t('membres.numeroEnAttente')}
              </Text>
              <Group gap={6}>
                <BadgeStatut domaine="membreAdhesion" valeur={m.statutAdhesion} />
                <BadgeStatut domaine="membreEtat" valeur={m.etat} />
                {m.anonymise && <Statut ton="neutre">{t('membres.anonymisee')}</Statut>}
                {m.doublonProbable && <Statut ton="attente">{t('membres.doublonTitre')}</Statut>}
                {m.estDiaspora && (
                  <Statut ton="neutre">
                    {t('membres.diasporaPays', { pays: nomPays(m.paysResidence) })}
                  </Statut>
                )}
              </Group>
              <Text size="sm">
                {t('membres.colTelephone')} : {telephone(m.telephone)}
              </Text>
              {famille && m.familleId && (
                <Text size="sm">
                  {t('membres.colFamille')} :{' '}
                  <Anchor component={Link} to={`/membres/familles/${m.familleId}`}>
                    {famille.nom}
                  </Anchor>
                </Text>
              )}
              {m.doublonProbable && m.doublonDe && (
                <Anchor component={Link} to={`/membres/${m.doublonDe}`} size="sm">
                  {t('membres.voirFicheSimilaire')}
                </Anchor>
              )}
              {m.etat !== 'actif' && m.motifEtat && (
                <Text size="sm" c="dimmed">
                  {t('membres.motifEtat', { motif: m.motifEtat })}
                </Text>
              )}
            </Stack>
          </Group>

          <Group gap="sm">
            {/* RG-MBR-009 : une fiche anonymisée n'est plus modifiable. */}
            {!m.anonymise && (
              <Si permission="membre.modifier">
                <Button component={Link} to={`/membres/${id}/modifier`} variant="default">
                  {t('membres.modifier')}
                </Button>
              </Si>
            )}
            {!m.anonymise && m.etat !== 'desactive' && (
              <Si permission="paiement.enregistrer">
                <Button
                  component={Link}
                  to="/cotisations/paiements/saisie"
                  search={{ membreId: id } as never}
                >
                  {t('paiements.enregistrerPaiement')}
                </Button>
              </Si>
            )}
            {/* RF-023 : carte PDF (refusée pour une fiche anonymisée ou désactivée). */}
            {!m.anonymise && m.etat !== 'desactive' && (
              <Button variant="default" loading={carteEnCours} onClick={() => void ouvrirCarte()}>
                {t('membres.carte')}
              </Button>
            )}
            {(peutChangerEtat || (peutAnonymiser && !m.anonymise)) && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button variant="default">{t('membres.autresActions')}</Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {peutChangerEtat && m.etat === 'actif' && (
                    <Menu.Item onClick={() => setAction('suspendre')}>{t('membres.suspendre')}</Menu.Item>
                  )}
                  {peutChangerEtat && m.etat !== 'actif' && (
                    <Menu.Item onClick={() => setAction('reactiver')}>{t('membres.reactiver')}</Menu.Item>
                  )}
                  {peutChangerEtat && m.etat !== 'desactive' && (
                    <Menu.Item onClick={() => setAction('desactiver')}>{t('membres.desactiver')}</Menu.Item>
                  )}
                  {peutAnonymiser && !m.anonymise && (
                    <Menu.Item color="red.9" onClick={() => setAction('anonymiser')}>
                      {t('membres.anonymiser')}
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 3 }} mt="lg">
          <div>
            <Text size="sm" c="dimmed">
              {t('membres.resteDu')}
            </Text>
            <Montant
              valeur={situation.data?.resteDu ?? 0}
              size="lg"
              c={situation.data?.resteDu ? '#A11B1B' : undefined}
            />
          </div>
          <div>
            <Text size="sm" c="dimmed">
              {t('membres.avance')}
            </Text>
            <Montant valeur={situation.data?.avance ?? 0} size="lg" />
          </div>
          <div>
            <Text size="sm" c="dimmed">
              {t('membres.echeancesEnRetard')}
            </Text>
            <Text fw={600} size="lg" c={situation.data?.echeancesEnRetard ? '#A11B1B' : undefined}>
              {situation.data?.echeancesEnRetard ?? 0}
            </Text>
          </div>
        </SimpleGrid>
      </Card>

      {erreurCarte && (
        <Alert color="red" role="alert">
          {erreurCarte}
        </Alert>
      )}
      <div role="status" aria-live="polite">
        {succes && (
          <Text c="#1B6B34" size="sm">
            {succes}
          </Text>
        )}
      </div>

      <Tabs defaultValue="situation" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="situation">{t('membres.ongletSituation')}</Tabs.Tab>
          <Tabs.Tab value="paiements">{t('membres.ongletPaiements')}</Tabs.Tab>
          <Tabs.Tab value="historique">{t('membres.ongletHistorique')}</Tabs.Tab>
          <Tabs.Tab value="ayantsDroit">{t('membres.ongletAyantsDroit')}</Tabs.Tab>
          <Tabs.Tab value="informations">{t('membres.ongletInformations')}</Tabs.Tab>
          <Tabs.Tab value="acces">{t('membres.ongletAccesApp')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="situation" pt="lg">
          <SituationMembre situation={situation} />
        </Tabs.Panel>
        <Tabs.Panel value="paiements" pt="lg">
          <PaiementsMembre membreId={id} />
        </Tabs.Panel>
        <Tabs.Panel value="historique" pt="lg">
          <HistoriqueMembre id={id} />
        </Tabs.Panel>
        <Tabs.Panel value="ayantsDroit" pt="lg">
          <AyantsDroit membreId={id} />
        </Tabs.Panel>
        <Tabs.Panel value="informations" pt="lg">
          <InformationsMembre membre={m} />
        </Tabs.Panel>
        <Tabs.Panel value="acces" pt="lg">
          <Bientot sprint="sprint 4" />
        </Tabs.Panel>
      </Tabs>

      <ConfirmationAction
        ouvert={action === 'suspendre'}
        onFermer={() => setAction(undefined)}
        titre={t('membres.suspensionTitre')}
        resume={t('membres.suspensionResume', { nom })}
        libelleConfirmer={t('membres.suspendre')}
        motifRequis
        danger
        onConfirmer={async (motif) =>
          apres(await postMembresIdSuspendre(id, { motif: motif! }), t('membres.suspensionOk', { nom }))
        }
      />
      <ConfirmationAction
        ouvert={action === 'reactiver'}
        onFermer={() => setAction(undefined)}
        titre={t('membres.reactivationTitre')}
        resume={t('membres.reactivationResume', { nom })}
        libelleConfirmer={t('membres.reactiver')}
        onConfirmer={async () =>
          apres(await postMembresIdReactiver(id), t('membres.reactivationOk', { nom }))
        }
      />
      <ConfirmationAction
        ouvert={action === 'desactiver'}
        onFermer={() => setAction(undefined)}
        titre={t('membres.desactivationTitre')}
        resume={t('membres.desactivationResume', { nom })}
        libelleConfirmer={t('membres.desactiver')}
        motifRequis
        danger
        onConfirmer={async (motif) =>
          apres(await postMembresIdDesactiver(id, { motif: motif! }), t('membres.desactivationOk', { nom }))
        }
      />
      <ConfirmationAction
        ouvert={action === 'anonymiser'}
        onFermer={() => setAction(undefined)}
        titre={t('membres.anonymisationTitre')}
        resume={t('membres.anonymisationResume', { nom, numero: m.numero ?? '' })}
        libelleConfirmer={t('commun.continuer')}
        motifRequis
        danger
        saisieConfirmation={{
          attendu: m.numero ?? m.id,
          consigne: t('membres.anonymisationConsigne', { numero: m.numero ?? m.id }),
          libelleConfirmer: t('membres.anonymiserDefinitivement'),
        }}
        onConfirmer={async (motif) =>
          apres(await postMembresIdAnonymiser(id, { motif: motif! }), t('membres.anonymisationOk'))
        }
      />
    </Stack>
  );
}

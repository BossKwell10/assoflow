import { masquerTelephone } from '@assoflow/contracts';
import { Alert, Button, Card, Group, Loader, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  getGetAccesQueryKey,
  postAccesIdDeverrouiller,
  postAccesIdRevoquer,
  useGetAcces,
} from '../../api/generated/acces-et-roles/acces-et-roles';
import type { Acces } from '../../api/generated/modeles';
import { usePermission } from '../../auth/SessionProvider';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { messageErreur } from '../../shared/erreurs';
import { formatDate, formatDateHeure } from '../../shared/format';
import { Statut, type Ton } from '../../shared/Statut';
import { InvitationAcces } from './InvitationAcces';

const TAILLE_PAGE = 50;
const STATUTS: Record<
  string,
  { ton: Ton; cle: 'utilisateurs.statutActif' | 'utilisateurs.statutRevoque' | 'utilisateurs.statutExpire' }
> = {
  actif: { ton: 'succes', cle: 'utilisateurs.statutActif' },
  revoque: { ton: 'alerte', cle: 'utilisateurs.statutRevoque' },
  expire: { ton: 'neutre', cle: 'utilisateurs.statutExpire' },
};

const nomComplet = (a: Acces) => `${a.user?.prenoms ?? ''} ${a.user?.nom ?? ''}`.trim();

function mandat(a: Acces): string {
  const parties = [
    a.mandatDebut ? t('utilisateurs.mandatDu', { debut: formatDate(a.mandatDebut) }) : '',
    a.mandatFin ? t('utilisateurs.mandatAu', { fin: formatDate(a.mandatFin) }) : '',
  ].filter(Boolean);
  return parties.join(' ');
}

type ActionEnCours = { type: 'revoquer' | 'deverrouiller'; acces: Acces };

export function ListeAcces() {
  const client = useQueryClient();
  const peutGerer = usePermission('utilisateur.gerer');
  // Pile des curseurs : pagination par curseur (docs/07 §3).
  const [curseurs, setCurseurs] = useState<string[]>([]);
  const curseur = curseurs.at(-1);
  const liste = useGetAcces({ limite: TAILLE_PAGE, ...(curseur ? { curseur } : {}) });
  const [invitation, setInvitation] = useState(false);
  const [action, setAction] = useState<ActionEnCours>();
  const [succes, setSucces] = useState<string>();

  const rafraichir = () => client.invalidateQueries({ queryKey: getGetAccesQueryKey() });
  const suivant = liste.data?.page.curseurSuivant;

  return (
    <Stack>
      <Group justify="space-between">
        <div role="status" aria-live="polite">
          {succes && (
            <Text c="#1B6B34" size="sm">
              {succes}
            </Text>
          )}
        </div>
        <Si permission="utilisateur.gerer">
          <Button onClick={() => setInvitation(true)}>{t('utilisateurs.inviter')}</Button>
        </Si>
      </Group>

      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        {liste.isPending && (
          <Group justify="center" p="xl">
            <Loader aria-label={t('commun.chargement')} />
          </Group>
        )}
        {liste.isError && (
          <Alert color="red" role="alert" m="md">
            {messageErreur(liste.error)}
          </Alert>
        )}
        {liste.data && liste.data.donnees.length === 0 && (
          <Text c="dimmed" p="lg">
            {t('commun.aucuneDonnee')}
          </Text>
        )}
        {liste.data && liste.data.donnees.length > 0 && (
          <ScrollArea>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover miw={900}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('utilisateurs.colNom')}</Table.Th>
                  <Table.Th>{t('utilisateurs.colTelephone')}</Table.Th>
                  <Table.Th>{t('utilisateurs.colRole')}</Table.Th>
                  <Table.Th>{t('utilisateurs.colMandat')}</Table.Th>
                  <Table.Th>{t('utilisateurs.colDerniereConnexion')}</Table.Th>
                  <Table.Th>{t('utilisateurs.colStatut')}</Table.Th>
                  {peutGerer && <Table.Th>{t('utilisateurs.colActions')}</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {liste.data.donnees.map((a) => {
                  const statut = STATUTS[a.statut ?? 'actif'] ?? STATUTS.actif!;
                  const nom = nomComplet(a);
                  return (
                    <Table.Tr key={a.id}>
                      <Table.Td fw={500}>{nom}</Table.Td>
                      <Table.Td>{a.user?.telephone ? masquerTelephone(a.user.telephone) : ''}</Table.Td>
                      <Table.Td>{a.role?.libelle}</Table.Td>
                      <Table.Td>{mandat(a)}</Table.Td>
                      <Table.Td>
                        {a.user?.derniereConnexion
                          ? formatDateHeure(a.user.derniereConnexion)
                          : t('utilisateurs.jamais')}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6}>
                          <Statut ton={statut.ton}>{t(statut.cle)}</Statut>
                          {a.user?.verrouille && <Statut ton="alerte">{t('utilisateurs.verrouille')}</Statut>}
                        </Group>
                      </Table.Td>
                      {peutGerer && (
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            {a.user?.verrouille && (
                              <Button
                                size="xs"
                                variant="default"
                                mih={36}
                                aria-label={t('utilisateurs.deverrouillerAria', { nom })}
                                onClick={() => setAction({ type: 'deverrouiller', acces: a })}
                              >
                                {t('utilisateurs.deverrouiller')}
                              </Button>
                            )}
                            {a.statut === 'actif' && (
                              <Button
                                size="xs"
                                variant="outline"
                                color="red.9"
                                mih={36}
                                aria-label={t('utilisateurs.revoquerAria', { nom })}
                                onClick={() => setAction({ type: 'revoquer', acces: a })}
                              >
                                {t('utilisateurs.revoquer')}
                              </Button>
                            )}
                          </Group>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>

      {(curseurs.length > 0 || suivant) && (
        <Group justify="flex-end">
          <Button
            variant="default"
            disabled={curseurs.length === 0}
            onClick={() => setCurseurs((c) => c.slice(0, -1))}
          >
            {t('commun.pagePrecedente')}
          </Button>
          <Button
            variant="default"
            disabled={!suivant}
            onClick={() => suivant && setCurseurs((c) => [...c, suivant])}
          >
            {t('commun.pageSuivante')}
          </Button>
        </Group>
      )}

      {invitation && (
        <InvitationAcces
          onFermer={() => setInvitation(false)}
          onInvite={(a) => {
            setSucces(t('utilisateurs.invitationOk', { nom: nomComplet(a) }));
            void rafraichir();
          }}
        />
      )}

      <ConfirmationAction
        ouvert={action?.type === 'revoquer'}
        onFermer={() => setAction(undefined)}
        titre={t('utilisateurs.revocationTitre')}
        resume={
          action &&
          t('utilisateurs.revocationResume', {
            nom: nomComplet(action.acces),
            role: action.acces.role?.libelle ?? '',
          })
        }
        libelleConfirmer={t('utilisateurs.revoquer')}
        motifRequis
        danger
        onConfirmer={async (motif) => {
          if (!action?.acces.id || !motif) return;
          await postAccesIdRevoquer(action.acces.id, { motif });
          setSucces(t('utilisateurs.revocationOk', { nom: nomComplet(action.acces) }));
          await rafraichir();
        }}
      />
      <ConfirmationAction
        ouvert={action?.type === 'deverrouiller'}
        onFermer={() => setAction(undefined)}
        titre={t('utilisateurs.deverrouillageTitre')}
        resume={action && t('utilisateurs.deverrouillageResume', { nom: nomComplet(action.acces) })}
        libelleConfirmer={t('utilisateurs.deverrouiller')}
        onConfirmer={async () => {
          if (!action?.acces.id) return;
          await postAccesIdDeverrouiller(action.acces.id);
          setSucces(t('utilisateurs.deverrouillageOk', { nom: nomComplet(action.acces) }));
          await rafraichir();
        }}
      />
    </Stack>
  );
}

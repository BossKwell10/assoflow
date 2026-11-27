import {
  formatMontant,
  LIBELLES_MODES_PAIEMENT,
  LIBELLES_OPERATEURS_MM,
  type ModePaiement,
  type OperateurMm,
} from '@assoflow/contracts';
import { Alert, Anchor, Button, Drawer, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  getPaiementsIdRecu,
  postPaiementsIdAnnuler,
  postPaiementsIdRenvoyerRecu,
  useGetPaiementsId,
} from '../../api/generated/cotisations/cotisations';
import type { Notification, Paiement } from '../../api/generated/modeles';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { telechargerBlob } from '../../shared/csv';
import { messageErreur } from '../../shared/erreurs';
import { formatDate, formatDateHeure } from '../../shared/format';
import { Montant } from '../../shared/Montant';
import { BadgeStatut } from '../../shared/Statut';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';

export const TAILLE_PAGE = 50;

/** « Mobile money (Wave) », « Espèces ». */
export const libelleMode = (p: { mode: string; operateurMm?: string | null }) =>
  `${LIBELLES_MODES_PAIEMENT[p.mode as ModePaiement] ?? p.mode}${
    p.operateurMm ? ` (${LIBELLES_OPERATEURS_MM[p.operateurMm as OperateurMm] ?? p.operateurMm})` : ''
  }`;

/** Statut affiché d'une ligne : paiement effectif, paiement annulé, ou ligne d'annulation (RG-COT-040). */
export const statutPaiement = (p: Pick<Paiement, 'type' | 'annule'>) =>
  p.type === 'annulation' ? 'annulation' : p.annule ? 'annule' : 'effectif';

/** Montant signé : une ligne d'annulation est une sortie. */
export const montantSigne = (p: Pick<Paiement, 'type' | 'montant'>) =>
  p.type === 'annulation' ? -p.montant : p.montant;

/** Total des paiements effectifs d'une liste (les annulations se compensent). */
export const totalPaiements = (lignes: readonly Paiement[]) =>
  lignes.reduce((total, p) => total + montantSigne(p), 0);

export function Payeur({ p }: { p: Paiement }) {
  if (p.membreId)
    return (
      <Anchor component={Link} to={`/membres/${p.membreId}`}>
        {p.membreNumero} — {p.membreNom}
      </Anchor>
    );
  if (p.familleId)
    return (
      <Anchor component={Link} to={`/membres/familles/${p.familleId}`}>
        {p.familleNom}
      </Anchor>
    );
  return <Text span>—</Text>;
}

/** Invalide paiements, échéances, campagnes, membres et comptes après une écriture financière. */
export const invaliderPaiements = (client: QueryClient) =>
  client.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === 'string' &&
      ['/paiements', '/echeances', '/campagnes', '/membres', '/familles', '/comptes'].some((p) =>
        (q.queryKey[0] as string).startsWith(p),
      ),
  });

/** Télécharge le reçu PDF d'un paiement (RF-033). */
export async function telechargerRecu(p: Pick<Paiement, 'id' | 'numeroRecu'>) {
  telechargerBlob(`recu-${p.numeroRecu}.pdf`, await getPaiementsIdRecu(p.id));
}

/** Colonnes communes des listes de paiements (A11, onglet Paiements de A3). */
export function colonnesPaiements(ouvrir: (p: Paiement) => void): Colonne<Paiement>[] {
  return [
    {
      cle: 'recu',
      titre: t('paiements.colRecu'),
      rendu: (p) => (
        <Stack gap={0}>
          <Text size="sm" fw={600}>
            {p.numeroRecu}
          </Text>
          {p.numeroRecuProvisoire && (
            <Text size="xs" c="dimmed">
              {t('paiements.provisoire', { numero: p.numeroRecuProvisoire })}
            </Text>
          )}
        </Stack>
      ),
    },
    { cle: 'date', titre: t('paiements.colDate'), rendu: (p) => formatDateHeure(p.datePaiement) },
    { cle: 'payeur', titre: t('paiements.colPayeur'), rendu: (p) => <Payeur p={p} /> },
    {
      cle: 'montant',
      titre: t('paiements.colMontant'),
      rendu: (p) => <Montant valeur={montantSigne(p)} size="sm" />,
    },
    { cle: 'mode', titre: t('paiements.colMode'), rendu: (p) => libelleMode(p) },
    { cle: 'compte', titre: t('paiements.colCompte'), rendu: (p) => p.compteLibelle },
    { cle: 'saisiPar', titre: t('paiements.colSaisiPar'), rendu: (p) => p.saisiPar?.nom ?? '' },
    {
      cle: 'statut',
      titre: t('paiements.colStatut'),
      rendu: (p) => <BadgeStatut domaine="paiement" valeur={statutPaiement(p)} />,
    },
    {
      cle: 'detail',
      titre: t('paiements.colDetail'),
      rendu: (p) => (
        <Button
          size="xs"
          variant="default"
          onClick={() => ouvrir(p)}
          aria-label={t('paiements.voirDetail', { numero: p.numeroRecu })}
        >
          {t('paiements.detail')}
        </Button>
      ),
    },
  ];
}

/**
 * Tableau des paiements avec total de la sélection et panneau de détail (docs/08 A11). La pagination est
 * fournie par l'appelant (URL pour A11, état local pour l'onglet de la fiche membre).
 */
export function TableauPaiements({
  libelle,
  lignes,
  chargement,
  erreur,
  pagination,
}: {
  libelle: string;
  lignes: readonly Paiement[] | undefined;
  chargement: boolean;
  erreur: unknown;
  pagination?: Parameters<typeof TableauDonnees<Paiement>>[0]['pagination'];
}) {
  const [ouvert, setOuvert] = useState<string>();
  return (
    <>
      <TableauDonnees
        libelle={libelle}
        colonnes={colonnesPaiements((p) => setOuvert(p.id))}
        lignes={lignes}
        cleLigne={(p) => p.id}
        libelleLigne={(p) => p.numeroRecu}
        chargement={chargement}
        erreur={erreur}
        pagination={pagination}
        messageVide={t('paiements.aucun')}
        actionsSelection={(selection) => (
          <Text size="sm">
            {t('paiements.totalSelection')} : <Montant valeur={totalPaiements(selection)} size="sm" />
          </Text>
        )}
      />
      {lignes && lignes.length > 0 && (
        <Group justify="flex-end">
          <Text size="sm" c="dimmed">
            {t('paiements.totalPage')} : <Montant valeur={totalPaiements(lignes)} size="sm" />
          </Text>
        </Group>
      )}
      <DetailPaiement id={ouvert} onFermer={() => setOuvert(undefined)} />
    </>
  );
}

/** Panneau latéral : imputations, reçu PDF, renvoi du reçu, annulation (docs/08 A11). */
export function DetailPaiement({ id, onFermer }: { id?: string; onFermer: () => void }) {
  const client = useQueryClient();
  const detail = useGetPaiementsId(id ?? '', { query: { enabled: Boolean(id) } });
  const [annulation, setAnnulation] = useState(false);
  const [message, setMessage] = useState<string>();
  const [notification, setNotification] = useState<Notification>();
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState<'recu' | 'renvoi'>();

  const fermer = () => {
    setMessage(undefined);
    setNotification(undefined);
    setErreur(undefined);
    onFermer();
  };
  const p = detail.data;
  const action = async (type: 'recu' | 'renvoi', travail: () => Promise<unknown>) => {
    setEnCours(type);
    setErreur(undefined);
    try {
      await travail();
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnCours(undefined);
    }
  };

  return (
    <Drawer
      opened={Boolean(id)}
      onClose={fermer}
      position="right"
      size="lg"
      title={p ? t('paiements.detailTitre', { numero: p.numeroRecu }) : t('paiements.detail')}
    >
      {detail.isPending && Boolean(id) && <Loader aria-label={t('commun.chargement')} />}
      {detail.isError && (
        <Alert color="red" role="alert">
          {messageErreur(detail.error)}
        </Alert>
      )}
      {p && (
        <Stack>
          <Group gap="xs">
            <BadgeStatut domaine="paiement" valeur={statutPaiement(p)} />
            {p.recuSms && (
              <Text size="sm">
                {t('paiements.sms')} <BadgeStatut domaine="notification" valeur={p.recuSms.statut} />{' '}
                {p.recuSms.destinataireMasque}
                {p.recuSms.relaisFamille ? ` (${t('paiements.relaisFamille')})` : ''}
              </Text>
            )}
          </Group>
          <Montant valeur={montantSigne(p)} size="xl" />
          <Text size="sm">
            <Payeur p={p} /> — {libelleMode(p)}
            {p.referenceExterne ? ` — ${t('paiements.reference', { reference: p.referenceExterne })}` : ''}
          </Text>
          <Text size="sm" c="dimmed">
            {t('paiements.saisiLe', {
              date: formatDateHeure(p.datePaiement),
              nom: p.saisiPar?.nom ?? '',
              compte: p.compteLibelle,
            })}
          </Text>
          {p.numeroRecuProvisoire && (
            <Text size="sm">{t('paiements.provisoire', { numero: p.numeroRecuProvisoire })}</Text>
          )}
          {p.motif && <Text size="sm">{t('paiements.motif', { motif: p.motif })}</Text>}
          {p.annulation && (
            <Alert color="gray">
              {t('paiements.annulePar', {
                numero: p.annulation.numeroRecu,
                date: formatDateHeure(p.annulation.datePaiement),
                nom: p.annulation.saisiPar,
                motif: p.annulation.motif,
              })}
            </Alert>
          )}

          <Text fw={600}>{t('paiements.imputations')}</Text>
          {p.imputations.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('paiements.aucuneImputation')}
            </Text>
          ) : (
            <Table aria-label={t('paiements.imputations')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('paiements.colCampagne')}</Table.Th>
                  <Table.Th>{t('paiements.colPeriode')}</Table.Th>
                  <Table.Th>{t('paiements.colMontant')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {p.imputations.map((i, n) => (
                  <Table.Tr key={`${i.echeanceId ?? 'avance'}-${n}`}>
                    <Table.Td>{i.campagneLibelle ?? t('paiements.avance')}</Table.Td>
                    <Table.Td>
                      {i.libellePeriode ?? '—'}
                      {i.dateEcheance ? ` (${formatDate(i.dateEcheance)})` : ''}
                    </Table.Td>
                    <Table.Td>
                      <Montant valeur={i.montant} size="sm" />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}

          {erreur && (
            <Alert color="red" role="alert">
              {erreur}
            </Alert>
          )}
          <div role="status" aria-live="polite">
            {message && (
              <Text c="#1B6B34" size="sm">
                {message}
              </Text>
            )}
            {notification && (
              <Text size="sm">
                {t('paiements.renvoiStatut')}{' '}
                <BadgeStatut domaine="notification" valeur={notification.statut} />
              </Text>
            )}
          </div>

          <Group>
            <Button
              variant="default"
              loading={enCours === 'recu'}
              onClick={() => void action('recu', () => telechargerRecu(p))}
            >
              {t('paiements.recuPdf')}
            </Button>
            <Si permission="paiement.enregistrer">
              <Button
                variant="default"
                loading={enCours === 'renvoi'}
                onClick={() =>
                  void action('renvoi', async () => {
                    setNotification(await postPaiementsIdRenvoyerRecu(p.id));
                  })
                }
              >
                {t('paiements.renvoyerRecu')}
              </Button>
            </Si>
            {/* RG-COT-041 : le serveur indique si l'utilisateur courant peut annuler ce paiement. */}
            {p.annulable && (
              <Button color="red.9" variant="outline" onClick={() => setAnnulation(true)}>
                {t('paiements.annuler')}
              </Button>
            )}
          </Group>
          <ConfirmationAction
            ouvert={annulation}
            onFermer={() => setAnnulation(false)}
            titre={t('paiements.annulationTitre')}
            resume={t('paiements.annulationResume', {
              numero: p.numeroRecu,
              montant: formatMontant(p.montant),
            })}
            libelleConfirmer={t('paiements.annuler')}
            motifRequis
            danger
            onConfirmer={async (motif) => {
              const ligne = await postPaiementsIdAnnuler(p.id, { motif: motif! });
              setMessage(t('paiements.annulationOk', { numero: ligne.numeroRecu }));
              await invaliderPaiements(client);
            }}
          />
        </Stack>
      )}
    </Drawer>
  );
}

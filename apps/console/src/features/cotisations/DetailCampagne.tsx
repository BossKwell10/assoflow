import { formatMontant } from '@assoflow/contracts';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  getGetCampagnesIdQueryKey,
  postCampagnesIdActiver,
  postCampagnesIdCloturer,
  postCampagnesIdMembres,
  useGetCampagnesId,
  useGetCampagnesIdApercu,
  useGetCampagnesIdEcheancier,
  useGetCampagnesIdStatistiques,
} from '../../api/generated/cotisations/cotisations';
import { useGetMembres } from '../../api/generated/membres/membres';
import type { Campagne, Echeance, Membre } from '../../api/generated/modeles';
import { Si, useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { AlerteErreur } from '../../shared/AlerteErreur';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { messageErreur } from '../../shared/erreurs';
import { formatDate } from '../../shared/format';
import { Montant } from '../../shared/Montant';
import { BadgeStatut } from '../../shared/Statut';
import { nomMembre } from '../membres/commun';
import {
  BarreTaux,
  formatTaux,
  invaliderCotisations,
  libellePeriodicite,
  libelleType,
  periodeCampagne,
} from './commun';
import { ActionEcheance, CouleursSituation } from './ActionEcheance';

const TAILLE_GRILLE = 25;

function Indicateur({ libelle, children }: { libelle: string; children: ReactNode }) {
  return (
    <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
      <Text size="sm" c="dimmed">
        {libelle}
      </Text>
      {children}
    </Card>
  );
}

/** Statistiques (RF-075) et recouvrement par période (barres : attendu vs recouvré). */
function Statistiques({ id }: { id: string }) {
  const stats = useGetCampagnesIdStatistiques(id);
  if (stats.isPending) return null;
  if (stats.isError) return <AlerteErreur erreur={stats.error} />;
  const s = stats.data;
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Indicateur libelle={t('campagnes.statAttendu')}>
          <Montant valeur={s.montantAttendu} size="lg" />
        </Indicateur>
        <Indicateur libelle={t('campagnes.statEchu')}>
          <Montant valeur={s.montantEchuAttendu} size="lg" />
        </Indicateur>
        <Indicateur libelle={t('campagnes.statRecouvre')}>
          <Montant valeur={s.montantRecouvre} size="lg" />
        </Indicateur>
        <Indicateur libelle={t('campagnes.tauxRecouvrement')}>
          <Text size="lg" fw={700}>
            {formatTaux(s.tauxRecouvrement)}
          </Text>
        </Indicateur>
      </SimpleGrid>
      {s.parPeriode.length > 0 && (
        <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
          <Text fw={600} mb="sm">
            {t('campagnes.recouvrementParPeriode')}
          </Text>
          <Table aria-label={t('campagnes.recouvrementParPeriode')} verticalSpacing={4}>
            <Table.Tbody>
              {s.parPeriode.map((p) => {
                const taux = p.montantAttendu > 0 ? p.montantRecouvre / p.montantAttendu : null;
                return (
                  <Table.Tr key={p.numeroPeriode}>
                    <Table.Td w={140}>
                      <Text size="sm">{p.libellePeriode}</Text>
                      <Text size="xs" c="dimmed">
                        {formatDate(p.dateEcheance)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <BarreTaux taux={taux} largeur={240} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {formatMontant(p.montantRecouvre)} / {formatMontant(p.montantAttendu)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {p.echeancesEnRetard > 0 && (
                        <Text size="sm" c="#A11B1B">
                          {t('campagnes.enRetardN', { n: p.echeancesEnRetard })}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}

/** Abréviation d'une situation dans une cellule (le libellé complet est dans l'infobulle). */
const ABREVIATIONS: Record<Echeance['situation'], string> = {
  payee: '✓',
  partielle: '½',
  en_retard: '!',
  a_venir: '·',
  exoneree: 'E',
};

/** Onglet Échéancier : membres × périodes, cellule colorée et libellée selon la situation. */
function Echeancier({ campagne }: { campagne: Campagne }) {
  const [saisie, setSaisie] = useState('');
  const [q] = useDebouncedValue(saisie.trim(), 300);
  const [curseurs, setCurseurs] = useState<string[]>([]);
  const [choisie, setChoisie] = useState<Echeance>();
  const grille = useGetCampagnesIdEcheancier(campagne.id!, {
    ...(q ? { q } : {}),
    limite: TAILLE_GRILLE,
    ...(curseurs.length ? { curseur: curseurs.at(-1) } : {}),
  });
  const lignes = grille.data?.donnees ?? [];
  const nombrePeriodes = Math.max(campagne.nombrePeriodes ?? 0, ...lignes.map((l) => l.echeances.length));
  const colonnes = Array.from({ length: nombrePeriodes }, (_, i) => {
    const p = lignes.flatMap((l) => l.echeances).find((e) => e.numeroPeriode === i + 1);
    return { numero: i + 1, libelle: p?.libellePeriode ?? String(i + 1) };
  });

  return (
    <Stack gap="sm">
      <TextInput
        label={t('campagnes.rechercherMembre')}
        type="search"
        value={saisie}
        onChange={(e) => {
          setSaisie(e.currentTarget.value);
          setCurseurs([]);
        }}
        maw={360}
      />
      <Group gap="md">
        {(Object.keys(ABREVIATIONS) as Echeance['situation'][]).map((s) => (
          <Group key={s} gap={6}>
            <CouleursSituation situation={s}>{ABREVIATIONS[s]}</CouleursSituation>
            <BadgeStatut domaine="echeance" valeur={s} />
          </Group>
        ))}
      </Group>
      {grille.isError && <AlerteErreur erreur={grille.error} />}
      <ScrollArea>
        <Table
          withTableBorder
          withColumnBorders
          aria-label={t('campagnes.echeancier')}
          miw={300 + 64 * colonnes.length}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('campagnes.colMembre')}</Table.Th>
              {colonnes.map((c) => (
                <Table.Th key={c.numero} ta="center">
                  {c.libelle}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lignes.map((l) => (
              <Table.Tr key={l.membreId}>
                <Table.Td>
                  <Anchor component={Link} to={`/membres/${l.membreId}`} size="sm">
                    {l.membreNumero} — {l.membreNom}
                  </Anchor>
                </Table.Td>
                {colonnes.map((c) => {
                  const e = l.echeances.find((x) => x.numeroPeriode === c.numero);
                  if (!e) return <Table.Td key={c.numero} />;
                  const libelle = `${l.membreNom}, ${e.libellePeriode} : ${t(`echeances.situation_${e.situation}`)}, ${formatMontant(e.montantPaye)} / ${formatMontant(e.montantDu)}`;
                  return (
                    <Table.Td key={c.numero} ta="center" p={2}>
                      <Tooltip label={libelle}>
                        <UnstyledButton aria-label={libelle} onClick={() => setChoisie(e)} w="100%">
                          <CouleursSituation situation={e.situation}>
                            {ABREVIATIONS[e.situation]}
                          </CouleursSituation>
                        </UnstyledButton>
                      </Tooltip>
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
            {!grille.isPending && lignes.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={colonnes.length + 1}>
                  <Text size="sm" c="dimmed">
                    {campagne.statut === 'brouillon'
                      ? t('campagnes.echeancierVide')
                      : t('commun.aucuneDonnee')}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Group gap="sm">
        <Button
          variant="default"
          disabled={!curseurs.length}
          onClick={() => setCurseurs((c) => c.slice(0, -1))}
        >
          {t('commun.pagePrecedente')}
        </Button>
        <Button
          variant="default"
          disabled={!grille.data?.page.curseurSuivant}
          onClick={() => setCurseurs((c) => [...c, grille.data!.page.curseurSuivant!])}
        >
          {t('commun.pageSuivante')}
        </Button>
      </Group>
      <ActionEcheance
        echeance={choisie}
        campagneActive={campagne.statut === 'active'}
        onFermer={() => setChoisie(undefined)}
      />
    </Stack>
  );
}

/** Ajout de membres à une campagne active (RG-COT-012), avec option de rattrapage. */
function AjoutMembres({
  campagne,
  ouvert,
  onFermer,
}: {
  campagne: Campagne;
  ouvert: boolean;
  onFermer: () => void;
}) {
  const client = useQueryClient();
  const [saisie, setSaisie] = useState('');
  const [q] = useDebouncedValue(saisie.trim(), 300);
  const [choisis, setChoisis] = useState<Map<string, Membre>>(new Map());
  const [rattrapage, setRattrapage] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string>();
  const [resultat, setResultat] = useState<string>();
  const recherche = useGetMembres({ q, limite: 10 }, { query: { enabled: ouvert && q.length >= 2 } });

  const fermer = () => {
    setSaisie('');
    setChoisis(new Map());
    setRattrapage(false);
    setErreur(undefined);
    setResultat(undefined);
    onFermer();
  };
  const basculer = (m: Membre) =>
    setChoisis((p) => {
      const n = new Map(p);
      if (n.has(m.id)) n.delete(m.id);
      else n.set(m.id, m);
      return n;
    });
  const ajouter = async () => {
    setEnCours(true);
    setErreur(undefined);
    try {
      const r = await postCampagnesIdMembres(campagne.id!, { membreIds: [...choisis.keys()], rattrapage });
      setResultat(t('campagnes.membresAjoutes', { n: r.echeancesCreees }));
      setChoisis(new Map());
      await invaliderCotisations(client);
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal opened={ouvert} onClose={fermer} title={t('campagnes.ajouterMembres')} centered size="lg">
      <Stack>
        <Text size="sm">{t('campagnes.ajouterAide')}</Text>
        <TextInput
          label={t('campagnes.rechercherMembre')}
          type="search"
          value={saisie}
          onChange={(e) => setSaisie(e.currentTarget.value)}
          data-autofocus
        />
        <Stack gap={4}>
          {(recherche.data?.donnees ?? []).map((m) => (
            <Checkbox
              key={m.id}
              label={`${m.numero ?? ''} — ${nomMembre(m)}`}
              checked={choisis.has(m.id)}
              onChange={() => basculer(m)}
            />
          ))}
        </Stack>
        {choisis.size > 0 && (
          <Text size="sm" fw={600}>
            {t('campagnes.membresChoisis', { n: choisis.size })}
          </Text>
        )}
        <Checkbox
          label={t('campagnes.rattrapage')}
          description={t('campagnes.rattrapageAide')}
          checked={rattrapage}
          onChange={(e) => setRattrapage(e.currentTarget.checked)}
        />
        {erreur && (
          <Alert color="red" role="alert">
            {erreur}
          </Alert>
        )}
        {resultat && (
          <Alert color="green" role="status">
            {resultat}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={fermer}>
            {t('commun.fermer')}
          </Button>
          <Button onClick={() => void ajouter()} loading={enCours} disabled={choisis.size === 0}>
            {t('campagnes.ajouter')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A9 — Campagne : statistiques, échéancier, actions (RF-031, RF-075). */
export function DetailCampagne() {
  const { id } = useParams({ strict: false }) as { id: string };
  const client = useQueryClient();
  const campagne = useGetCampagnesId(id);
  const brouillon = campagne.data?.statut === 'brouillon';
  const apercu = useGetCampagnesIdApercu(id, { query: { enabled: brouillon, staleTime: 0 } });
  const peutGerer = useAuMoinsUnePermission('cotisation.gerer');
  const [action, setAction] = useState<'activer' | 'cloturer' | 'membres'>();
  const [succes, setSucces] = useState<string>();

  if (campagne.isPending) return null;
  if (campagne.isError) return <AlerteErreur erreur={campagne.error} />;
  const c = campagne.data;
  const a = apercu.data;

  const apres = async (maj: Campagne, message: string) => {
    client.setQueryData(getGetCampagnesIdQueryKey(id), maj);
    setSucces(message);
    await invaliderCotisations(client);
  };

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/cotisations/campagnes" size="sm">
        ← {t('campagnes.retourListe')}
      </Anchor>
      <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
        <Group justify="space-between" align="flex-start">
          <Stack gap={6}>
            <Group gap="sm">
              <Title order={1} size={26}>
                {c.libelle}
              </Title>
              <BadgeStatut domaine="campagne" valeur={c.statut} />
            </Group>
            <Text size="sm">
              {libelleType(c)} · {libellePeriodicite(c.periodicite)} · {formatMontant(c.montant)}{' '}
              {t('campagnes.parPeriode')} · {periodeCampagne(c)}
            </Text>
            <Text size="sm" c="dimmed">
              {t('campagnes.nombrePeriodes', { n: c.nombrePeriodes ?? 0 })}
            </Text>
          </Stack>
          {peutGerer && (
            <Group gap="sm">
              {c.statut !== 'cloturee' && (
                <Button component={Link} to={`/cotisations/campagnes/${id}/modifier`} variant="default">
                  {c.statut === 'active' ? t('campagnes.modifierProlonger') : t('campagnes.modifier')}
                </Button>
              )}
              {c.statut === 'active' && (
                <Button variant="default" onClick={() => setAction('membres')}>
                  {t('campagnes.ajouterMembres')}
                </Button>
              )}
              {c.statut === 'active' && (
                <Button variant="default" color="red" onClick={() => setAction('cloturer')}>
                  {t('campagnes.cloturer')}
                </Button>
              )}
              {brouillon && <Button onClick={() => setAction('activer')}>{t('campagnes.activer')}</Button>}
            </Group>
          )}
        </Group>
      </Card>

      <div role="status" aria-live="polite">
        {succes && (
          <Text c="#1B6B34" size="sm">
            {succes}
          </Text>
        )}
      </div>

      {brouillon && (
        <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
          <Stack gap={6}>
            <Text fw={600}>{t('campagnes.apercuActivation')}</Text>
            {apercu.isError && <AlerteErreur erreur={apercu.error} />}
            {a && (
              <>
                <Text>
                  {t('campagnes.apercuServeur', {
                    membres: a.membresCibles,
                    echeances: a.nombreEcheances,
                    montant: formatMontant(a.montantTotal),
                  })}
                </Text>
                <Text size="sm" c="dimmed">
                  {a.periodes
                    .slice(0, 3)
                    .map((p) => `${p.libelle} (${formatDate(p.dateEcheance)})`)
                    .join(' · ')}
                  {a.periodes.length > 3 ? ' …' : ''}
                </Text>
              </>
            )}
          </Stack>
        </Card>
      )}

      {!brouillon && <Statistiques id={id} />}

      <Tabs defaultValue="echeancier" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="echeancier">{t('campagnes.echeancier')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="echeancier" pt="md">
          <Echeancier campagne={c} />
        </Tabs.Panel>
      </Tabs>

      <Si permission="cotisation.gerer">
        <ConfirmationAction
          ouvert={action === 'activer'}
          onFermer={() => setAction(undefined)}
          titre={t('campagnes.activerTitre')}
          resume={
            a
              ? t('campagnes.activerResume', {
                  libelle: c.libelle,
                  membres: a.membresCibles,
                  echeances: a.nombreEcheances,
                  montant: formatMontant(a.montantTotal),
                })
              : c.libelle
          }
          libelleConfirmer={t('campagnes.activer')}
          onConfirmer={async () =>
            apres(await postCampagnesIdActiver(id), t('campagnes.activee', { libelle: c.libelle }))
          }
        />
        <ConfirmationAction
          ouvert={action === 'cloturer'}
          onFermer={() => setAction(undefined)}
          titre={t('campagnes.cloturerTitre')}
          resume={t('campagnes.cloturerResume', { libelle: c.libelle })}
          libelleConfirmer={t('campagnes.cloturer')}
          danger
          onConfirmer={async () =>
            apres(await postCampagnesIdCloturer(id), t('campagnes.cloturee', { libelle: c.libelle }))
          }
        />
        <AjoutMembres campagne={c} ouvert={action === 'membres'} onFermer={() => setAction(undefined)} />
      </Si>
    </Stack>
  );
}

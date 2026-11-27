import {
  confirmationMontantRequise,
  formatMontant,
  LIBELLES_MODES_PAIEMENT,
  LIBELLES_OPERATEURS_MM,
  MODES_PAIEMENT,
  OPERATEURS_MM,
  paiementCreationSchema,
  TYPE_COMPTE_PAR_MODE,
  type ModePaiement,
} from '@assoflow/contracts';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Modal,
  NativeSelect,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getPaiementsId, postPaiements, useGetCampagnes } from '../../api/generated/cotisations/cotisations';
import {
  useGetFamilles,
  useGetFamillesIdMembres,
  useGetMembres,
  useGetMembresId,
  useGetMembresIdSituation,
} from '../../api/generated/membres/membres';
import type { Membre, Paiement, PaiementCreation } from '../../api/generated/modeles';
import { useGetComptes } from '../../api/generated/tresorerie/tresorerie';
import { t } from '../../i18n';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { Montant } from '../../shared/Montant';
import { BadgeStatut } from '../../shared/Statut';
import { uuidV7 } from '../../shared/uuid';
import { ChampMontant } from '../../shared/ChampMontant';
import { nomMembre } from '../membres/commun';
import { invaliderPaiements, libelleMode, Payeur } from './commun';
import type { RechercheSaisie } from './recherche';

/** Raccourcis clavier des modes (docs/08 A12) : E espèces, M mobile money, V virement, C chèque. */
const RACCOURCIS: Record<string, ModePaiement> = {
  e: 'especes',
  m: 'mobile_money',
  v: 'virement',
  c: 'cheque',
};

/** Date du jour au format AAAA-MM-JJ (GMT, docs/08 §2). */
const aujourdhui = () => new Date().toISOString().slice(0, 10);

/** Recherche d'un membre au clavier : nom, prénoms, numéro ou téléphone ; `↓`/`↑` puis `Entrée`. */
function RechercheMembre({
  onChoisir,
  champRef,
}: {
  onChoisir: (m: Membre) => void;
  champRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [saisie, setSaisie] = useState('');
  const [q] = useDebouncedValue(saisie.trim(), 200);
  const [index, setIndex] = useState(0);
  const resultats = useGetMembres({ q, limite: 8 }, { query: { enabled: q.length >= 2 } });
  const liste = q.length >= 2 ? (resultats.data?.donnees ?? []) : [];

  const choisir = (m: Membre) => {
    setSaisie('');
    setIndex(0);
    onChoisir(m);
  };
  const clavier = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(liste.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      // Entrée choisit le membre en surbrillance (et n'enregistre pas le formulaire).
      e.preventDefault();
      const m = liste[index];
      if (m) choisir(m);
    }
  };

  return (
    <Stack gap={4} pos="relative">
      <TextInput
        ref={champRef}
        label={t('saisie.membre')}
        description={t('saisie.membreAide')}
        type="search"
        autoComplete="off"
        value={saisie}
        onChange={(e) => {
          setSaisie(e.currentTarget.value);
          setIndex(0);
        }}
        onKeyDown={clavier}
        role="combobox"
        aria-expanded={liste.length > 0}
        aria-controls="saisie-resultats-membres"
        aria-activedescendant={liste[index] ? `saisie-membre-${liste[index].id}` : undefined}
      />
      {liste.length > 0 && (
        <Paper
          withBorder
          shadow="sm"
          role="listbox"
          id="saisie-resultats-membres"
          aria-label={t('saisie.resultats')}
        >
          {liste.map((m, i) => (
            <UnstyledButton
              key={m.id}
              id={`saisie-membre-${m.id}`}
              role="option"
              aria-selected={i === index}
              display="block"
              w="100%"
              px="sm"
              py={6}
              bg={i === index ? '#E7F3F1' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choisir(m)}
            >
              <Text size="sm">
                {m.numero} — {nomMembre(m)}
                {(m.soldeCotisations ?? 0) < 0 &&
                  ` · ${t('saisie.resteDu', { montant: formatMontant(-(m.soldeCotisations ?? 0)) })}`}
              </Text>
            </UnstyledButton>
          ))}
        </Paper>
      )}
    </Stack>
  );
}

interface Ligne {
  membre?: Membre;
  familleId?: string;
  montant: number | null;
  mode: ModePaiement;
  operateurMm: string;
  referenceExterne: string;
  compteId: string;
  campagneId: string;
  date: string;
}

/**
 * A12 — Saisie de paiements en série (critère d'acceptation 1 : 20 paiements en moins de 10 minutes).
 * Une ligne de saisie unique ; `Entrée` enregistre (id UUIDv7 généré ici, clé d'idempotence) et vide la ligne.
 */
export function SaisiePaiements() {
  const recherche = useSearch({ strict: false }) as RechercheSaisie;
  const client = useQueryClient();
  const comptes = useGetComptes({ query: { staleTime: 60_000 } });
  const campagnes = useGetCampagnes({ statut: 'active', limite: 200 }, { query: { staleTime: 60_000 } });
  const familles = useGetFamilles({ limite: 200 }, { query: { staleTime: 60_000 } });
  const champMembre = useRef<HTMLInputElement>(null);
  const [famille, setFamille] = useState(Boolean(recherche.familleId));
  const [ligne, setLigne] = useState<Ligne>({
    familleId: recherche.familleId,
    montant: null,
    mode: 'especes',
    operateurMm: '',
    referenceExterne: '',
    compteId: '',
    campagneId: '',
    date: aujourdhui(),
  });
  const maj = (c: Partial<Ligne>) => setLigne((l) => ({ ...l, ...c }));
  const [session, setSession] = useState<Paiement[]>([]);
  const [erreur, setErreur] = useState<unknown>();
  const [erreursLocales, setErreursLocales] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState(false);
  const [enCours, setEnCours] = useState(false);

  // Membre pré-rempli depuis la fiche (A3 → « Enregistrer un paiement »).
  const prerempli = useGetMembresId(recherche.membreId ?? '', {
    query: { enabled: Boolean(recherche.membreId) && !famille },
  });
  useEffect(() => {
    if (prerempli.data && !ligne.membre) setLigne((l) => ({ ...l, membre: prerempli.data }));
  }, [prerempli.data]);

  // Montant pré-rempli avec le reste dû du membre (RF-035), modifiable.
  const situation = useGetMembresIdSituation(ligne.membre?.id ?? '', {
    query: { enabled: Boolean(ligne.membre) },
  });
  useEffect(() => {
    if (situation.data && ligne.montant === null && (situation.data.resteDu ?? 0) > 0) {
      setLigne((l) => ({ ...l, montant: situation.data.resteDu ?? null }));
    }
  }, [situation.data]);

  // Mode famille : reste dû cumulé des membres (soldes négatifs).
  const membresFamille = useGetFamillesIdMembres(ligne.familleId ?? '', {
    query: { enabled: famille && Boolean(ligne.familleId) },
  });
  const resteDuFamille = (membresFamille.data ?? []).reduce(
    (total, m) => total + Math.max(0, -(m.soldeCotisations ?? 0)),
    0,
  );
  useEffect(() => {
    if (famille && membresFamille.data && ligne.montant === null && resteDuFamille > 0) {
      setLigne((l) => ({ ...l, montant: resteDuFamille }));
    }
  }, [membresFamille.data]);

  // RG-COT-032 : compte par défaut selon le mode (Caisse pour les espèces…).
  const listeComptes = (comptes.data ?? []).filter((c) => c.actif !== false);
  const compteParDefaut = (mode: ModePaiement) =>
    (listeComptes.find((c) => c.type === TYPE_COMPTE_PAR_MODE[mode]) ?? listeComptes[0])?.id ?? '';
  useEffect(() => {
    if (!ligne.compteId && listeComptes.length > 0) {
      setLigne((l) => ({ ...l, compteId: compteParDefaut(l.mode) }));
    }
  }, [comptes.data]);

  const changerMode = (mode: ModePaiement) =>
    setLigne((l) => ({
      ...l,
      mode,
      operateurMm: mode === 'mobile_money' ? l.operateurMm : '',
      compteId: compteParDefaut(mode),
    }));
  /** Raccourcis sur le sélecteur de mode (lettre seule). */
  const raccourciMode = (e: KeyboardEvent<HTMLElement>) => {
    const mode = RACCOURCIS[e.key.toLowerCase()];
    if (mode && !e.altKey && (e.target as HTMLElement).closest('[data-selecteur-mode]') !== null) {
      e.preventDefault();
      changerMode(mode);
    }
  };
  // Alt + lettre depuis n'importe où dans l'écran (saisie au clavier sans quitter le champ montant).
  const changerModeRef = useRef(changerMode);
  changerModeRef.current = changerMode;
  useEffect(() => {
    const ecouter = (e: globalThis.KeyboardEvent) => {
      const mode = e.altKey ? RACCOURCIS[e.key.toLowerCase()] : undefined;
      if (mode) {
        e.preventDefault();
        changerModeRef.current(mode);
      }
    };
    window.addEventListener('keydown', ecouter);
    return () => window.removeEventListener('keydown', ecouter);
  }, []);

  const viderLigne = () => {
    setLigne((l) => ({ ...l, membre: undefined, familleId: undefined, montant: null, referenceExterne: '' }));
    setErreur(undefined);
    setErreursLocales({});
    // Le champ de recherche réapparaît au rendu suivant.
    setTimeout(() => champMembre.current?.focus());
  };

  const corps = (confirme: boolean): PaiementCreation => ({
    id: uuidV7(),
    ...(famille ? { familleId: ligne.familleId } : { membreId: ligne.membre?.id }),
    campagneId: ligne.campagneId || null,
    montant: ligne.montant ?? 0,
    mode: ligne.mode,
    operateurMm:
      ligne.mode === 'mobile_money' ? ((ligne.operateurMm || null) as PaiementCreation['operateurMm']) : null,
    referenceExterne: ligne.referenceExterne.trim() || null,
    compteId: ligne.compteId,
    // Date du jour : l'heure réelle ; date passée : midi GMT (date métier, RG-EXE-002).
    datePaiement: ligne.date === aujourdhui() ? new Date().toISOString() : `${ligne.date}T12:00:00Z`,
    ...(confirme ? { confirmationMontantEleve: true } : {}),
  });

  const envoyer = async (confirme: boolean) => {
    const c = corps(confirme);
    const verifie = paiementCreationSchema.safeParse(c);
    const locales: Record<string, string> = {};
    if (!verifie.success) {
      for (const i of verifie.error.issues) locales[String(i.path[0])] ??= i.message;
    }
    if (!ligne.compteId) locales.compteId = t('saisie.compteRequis');
    if (Object.keys(locales).length > 0) {
      if (locales.familleId && !locales.membreId) locales.membreId = locales.familleId;
      setErreursLocales(locales);
      return;
    }
    if (!confirme && confirmationMontantRequise(c.montant)) {
      setConfirmation(true);
      return;
    }
    setEnCours(true);
    setErreur(undefined);
    setErreursLocales({});
    try {
      const p = await postPaiements(c);
      setSession((s) => [p, ...s]);
      setConfirmation(false);
      viderLigne();
      await invaliderPaiements(client);
    } catch (e) {
      setConfirmation(false);
      setErreur(e);
    } finally {
      setEnCours(false);
    }
  };

  const actualiserSms = async () => {
    const maj = await Promise.all(session.map((p) => getPaiementsId(p.id).catch(() => p)));
    setSession(maj);
  };

  const erreursApi = erreursDeChamps(erreur);
  const erreurChamp = (champ: string) => erreursLocales[champ] ?? erreursApi[champ];
  const total = session.reduce((s, p) => s + p.montant, 0);
  const parMode = MODES_PAIEMENT.map((m) => ({
    mode: m,
    n: session.filter((p) => p.mode === m).length,
    total: session.filter((p) => p.mode === m).reduce((s, p) => s + p.montant, 0),
  })).filter((x) => x.n > 0);
  const nomFamille = familles.data?.donnees.find((f) => f.id === ligne.familleId)?.nom ?? '';
  const payeur = famille
    ? nomFamille
    : ligne.membre
      ? `${ligne.membre.numero} — ${nomMembre(ligne.membre)}`
      : '';

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/cotisations/paiements" size="sm">
        ← {t('paiements.titre')}
      </Anchor>
      <Title order={1} size={28}>
        {t('saisie.titre')}
      </Title>

      <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
        {/* Validation par le schéma partagé (messages en français), pas par le navigateur. */}
        <form
          noValidate
          aria-label={t('saisie.ligne')}
          onKeyDown={raccourciMode}
          onSubmit={(e) => {
            e.preventDefault();
            void envoyer(false);
          }}
        >
          <Stack>
            <SegmentedControl
              w="fit-content"
              value={famille ? 'famille' : 'membre'}
              onChange={(v) => {
                setFamille(v === 'famille');
                setLigne((l) => ({ ...l, membre: undefined, familleId: undefined, montant: null }));
              }}
              data={[
                { value: 'membre', label: t('saisie.modeMembre') },
                { value: 'famille', label: t('saisie.modeFamille') },
              ]}
            />
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {famille ? (
                <Stack gap={4}>
                  <NativeSelect
                    label={t('saisie.famille')}
                    value={ligne.familleId ?? ''}
                    error={erreurChamp('membreId') ?? erreurChamp('familleId')}
                    onChange={(e) => maj({ familleId: e.currentTarget.value || undefined })}
                    data={[
                      { value: '', label: t('saisie.choisirFamille') },
                      ...(familles.data?.donnees ?? []).map((f) => ({ value: f.id ?? '', label: f.nom })),
                    ]}
                  />
                  {ligne.familleId && (
                    <Text size="sm">
                      {t('saisie.resteDuCumule')} : <Montant valeur={resteDuFamille} size="sm" />
                    </Text>
                  )}
                </Stack>
              ) : ligne.membre ? (
                <Stack gap={4}>
                  <Text size="sm" fw={500}>
                    {t('saisie.membre')}
                  </Text>
                  <Group gap="sm">
                    <Text fw={600}>
                      {ligne.membre.numero} — {nomMembre(ligne.membre)}
                    </Text>
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => {
                        setLigne((l) => ({ ...l, membre: undefined, montant: null }));
                        setTimeout(() => champMembre.current?.focus());
                      }}
                    >
                      {t('saisie.changer')}
                    </Button>
                  </Group>
                  {situation.data && (
                    <Text size="sm">
                      {t('saisie.resteDuLibelle')} :{' '}
                      <Montant valeur={situation.data.resteDu ?? 0} size="sm" />
                    </Text>
                  )}
                </Stack>
              ) : (
                <Stack gap={0}>
                  <RechercheMembre
                    champRef={champMembre}
                    onChoisir={(m) => setLigne((l) => ({ ...l, membre: m, montant: null }))}
                  />
                  {erreurChamp('membreId') && (
                    <Text size="xs" c="red.8" role="alert">
                      {erreurChamp('membreId')}
                    </Text>
                  )}
                </Stack>
              )}
              <ChampMontant
                label={t('saisie.montant')}
                withAsterisk
                value={ligne.montant}
                onChange={(montant) => setLigne((l) => ({ ...l, montant }))}
                error={erreurChamp('montant')}
              />
            </SimpleGrid>

            <Stack gap={4} data-selecteur-mode>
              <Text size="sm" fw={500} id="saisie-mode">
                {t('saisie.mode')}
              </Text>
              <SegmentedControl
                aria-labelledby="saisie-mode"
                w="fit-content"
                value={ligne.mode}
                onChange={(v) => changerMode(v as ModePaiement)}
                data={MODES_PAIEMENT.map((m) => ({ value: m, label: LIBELLES_MODES_PAIEMENT[m] }))}
              />
              <Text size="xs" c="dimmed">
                {t('saisie.raccourcis')}
              </Text>
            </Stack>

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              {ligne.mode === 'mobile_money' && (
                <NativeSelect
                  label={t('saisie.operateur')}
                  withAsterisk
                  value={ligne.operateurMm}
                  error={erreurChamp('operateurMm')}
                  onChange={(e) => maj({ operateurMm: e.currentTarget.value })}
                  data={[
                    { value: '', label: t('saisie.choisirOperateur') },
                    ...OPERATEURS_MM.map((o) => ({ value: o, label: LIBELLES_OPERATEURS_MM[o] })),
                  ]}
                />
              )}
              <TextInput
                label={t('saisie.reference')}
                value={ligne.referenceExterne}
                error={erreurChamp('referenceExterne')}
                onChange={(e) => maj({ referenceExterne: e.currentTarget.value })}
              />
              <NativeSelect
                label={t('saisie.compte')}
                value={ligne.compteId}
                error={erreurChamp('compteId')}
                onChange={(e) => maj({ compteId: e.currentTarget.value })}
                data={[
                  { value: '', label: t('saisie.choisirCompte') },
                  ...listeComptes.map((c) => ({ value: c.id ?? '', label: c.libelle })),
                ]}
              />
              <NativeSelect
                label={t('saisie.campagne')}
                value={ligne.campagneId}
                onChange={(e) => maj({ campagneId: e.currentTarget.value })}
                data={[
                  { value: '', label: t('saisie.imputationAuto') },
                  ...(campagnes.data?.donnees ?? []).map((c) => ({ value: c.id ?? '', label: c.libelle })),
                ]}
              />
              <TextInput
                type="date"
                label={t('saisie.date')}
                value={ligne.date}
                max={aujourdhui()}
                error={erreurChamp('datePaiement')}
                onChange={(e) => maj({ date: e.currentTarget.value || aujourdhui() })}
              />
            </SimpleGrid>

            {erreur !== undefined && (
              <Alert color="red" role="alert">
                {messageErreur(erreur)}
              </Alert>
            )}
            <Group>
              <Button type="submit" loading={enCours}>
                {t('saisie.enregistrer')}
              </Button>
              <Text size="xs" c="dimmed">
                {t('saisie.entreeEnregistre')}
              </Text>
            </Group>
          </Stack>
        </form>
      </Card>

      <Modal
        opened={confirmation}
        onClose={() => setConfirmation(false)}
        title={t('saisie.confirmationTitre')}
        centered
      >
        <Stack>
          <Text>
            {t('saisie.confirmationResume', { montant: formatMontant(ligne.montant ?? 0), payeur })}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmation(false)}>
              {t('commun.annuler')}
            </Button>
            <Button loading={enCours} onClick={() => void envoyer(true)}>
              {t('saisie.confirmerMontant')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }} className="bordereau">
        <Group justify="space-between" mb="sm">
          <Title order={2} size={20}>
            {t('saisie.session')}
          </Title>
          <Group gap="sm">
            {session.length > 0 && (
              <Button size="xs" variant="default" onClick={() => void actualiserSms()}>
                {t('saisie.actualiserSms')}
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              disabled={session.length === 0}
              onClick={() => window.print()}
            >
              {t('saisie.imprimer')}
            </Button>
          </Group>
        </Group>
        {session.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t('saisie.sessionVide')}
          </Text>
        ) : (
          <Stack>
            <Table aria-label={t('saisie.session')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('paiements.colRecu')}</Table.Th>
                  <Table.Th>{t('paiements.colPayeur')}</Table.Th>
                  <Table.Th>{t('paiements.colMontant')}</Table.Th>
                  <Table.Th>{t('paiements.colMode')}</Table.Th>
                  <Table.Th>{t('saisie.colSms')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {session.map((p) => (
                  <Table.Tr key={p.id}>
                    <Table.Td>{p.numeroRecu}</Table.Td>
                    <Table.Td>
                      <Payeur p={p} />
                    </Table.Td>
                    <Table.Td>
                      <Montant valeur={p.montant} size="sm" />
                    </Table.Td>
                    <Table.Td>{libelleMode(p)}</Table.Td>
                    <Table.Td>
                      {p.recuSms ? (
                        <BadgeStatut domaine="notification" valeur={p.recuSms.statut} />
                      ) : (
                        <Text size="sm" c="dimmed">
                          {t('saisie.sansSms')}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Group gap="xl" role="region" aria-label={t('saisie.recapitulatif')}>
              <Text size="sm" fw={600}>
                {t('saisie.recapNombre', { n: session.length })} — <Montant valeur={total} size="sm" />
              </Text>
              {parMode.map((x) => (
                <Text key={x.mode} size="sm">
                  {LIBELLES_MODES_PAIEMENT[x.mode]} ({x.n}) : <Montant valeur={x.total} size="sm" />
                </Text>
              ))}
            </Group>
          </Stack>
        )}
      </Card>
    </Stack>
  );
}

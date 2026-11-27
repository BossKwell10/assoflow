import {
  MODELES_NOTIFICATION,
  reunionCreationSchema,
  rendreModele,
  TYPES_REUNION,
} from '@assoflow/contracts';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  NativeSelect,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useGetAssociation } from '../../api/generated/association/association';
import { useGetCategoriesMembres, useGetMembres } from '../../api/generated/membres/membres';
import type { Diffusion, Membre, Reunion } from '../../api/generated/modeles';
import {
  getGetReunionsQueryKey,
  postReunions,
  postReunionsIdConvoquer,
  useGetReunions,
} from '../../api/generated/reunions/reunions';
import { t } from '../../i18n';
import { ApercuSms } from '../../shared/ApercuSms';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatDateHeure } from '../../shared/format';
import { ResultatDiffusion } from '../../shared/ResultatDiffusion';
import { BadgeStatut } from '../../shared/Statut';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import { nomMembre } from '../membres/commun';

const libelleType = (type: string) => t(`reunions.type_${type as (typeof TYPES_REUNION)[number]}`);

/** « 12/04/2027 a 10:00 » : date et heure pour le SMS (GSM-7, docs/06 §5). */
const dateSms = (iso: string) => formatDateHeure(iso).replace(' ', ' a ');

/** Planification d'une réunion (RF-080, sprint 4 : pour la convocation par SMS). */
function NouvelleReunion({ ouvert, onFermer }: { ouvert: boolean; onFermer: () => void }) {
  const client = useQueryClient();
  const [champs, setChamps] = useState({
    type: 'ag_ordinaire',
    titre: '',
    date: '',
    heure: '10:00',
    lieu: '',
    ordreDuJour: '',
  });
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);
  const maj = (c: Partial<typeof champs>) => setChamps((p) => ({ ...p, ...c }));

  const creer = async () => {
    const corps = {
      type: champs.type as Reunion['type'],
      titre: champs.titre,
      debut: champs.date ? `${champs.date}T${champs.heure || '00:00'}:00Z` : '',
      lieu: champs.lieu,
      ordreDuJour: champs.ordreDuJour,
    };
    const verifie = reunionCreationSchema.safeParse(corps);
    if (!verifie.success) {
      const e: Record<string, string> = {};
      for (const i of verifie.error.issues) e[String(i.path[0])] ??= i.message;
      setErreurs(e);
      return;
    }
    setEnCours(true);
    setErreur(undefined);
    try {
      await postReunions(verifie.data);
      await client.invalidateQueries({ queryKey: getGetReunionsQueryKey() });
      setChamps({ type: 'ag_ordinaire', titre: '', date: '', heure: '10:00', lieu: '', ordreDuJour: '' });
      setErreurs({});
      onFermer();
    } catch (e) {
      setErreur(e);
      setErreurs(erreursDeChamps(e));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal opened={ouvert} onClose={onFermer} title={t('reunions.nouvelle')} centered size="lg">
      <Stack>
        <NativeSelect
          label={t('reunions.type')}
          value={champs.type}
          onChange={(e) => maj({ type: e.currentTarget.value })}
          data={TYPES_REUNION.map((ty) => ({ value: ty, label: libelleType(ty) }))}
        />
        <TextInput
          label={t('reunions.titreReunion')}
          required
          value={champs.titre}
          error={erreurs.titre}
          onChange={(e) => maj({ titre: e.currentTarget.value })}
        />
        <SimpleGrid cols={2}>
          <TextInput
            type="date"
            label={t('reunions.date')}
            required
            value={champs.date}
            error={erreurs.debut}
            onChange={(e) => maj({ date: e.currentTarget.value })}
          />
          <TextInput
            type="time"
            label={t('reunions.heure')}
            value={champs.heure}
            onChange={(e) => maj({ heure: e.currentTarget.value })}
          />
        </SimpleGrid>
        <TextInput
          label={t('reunions.lieu')}
          value={champs.lieu}
          onChange={(e) => maj({ lieu: e.currentTarget.value })}
        />
        <Textarea
          label={t('reunions.ordreDuJour')}
          rows={4}
          value={champs.ordreDuJour}
          onChange={(e) => maj({ ordreDuJour: e.currentTarget.value })}
        />
        {erreur !== undefined && (
          <Alert color="red" role="alert">
            {messageErreur(erreur)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onFermer}>
            {t('commun.annuler')}
          </Button>
          <Button loading={enCours} onClick={() => void creer()}>
            {t('reunions.planifier')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type Cible = 'tous' | 'categories' | 'membres';

/** Convocation par SMS (E6-08, RF-063) : cible, aperçu du message, confirmation, résultat. */
function Convocation({ reunion, onFermer }: { reunion?: Reunion; onFermer: () => void }) {
  const client = useQueryClient();
  const assoc = useGetAssociation({ query: { staleTime: 5 * 60_000 } });
  const association = assoc.data?.sigle || assoc.data?.nom || '';
  const categories = useGetCategoriesMembres({ query: { staleTime: 5 * 60_000 } });
  const [cible, setCible] = useState<Cible>('tous');
  const [choixCategories, setChoixCategories] = useState<string[]>([]);
  const [saisie, setSaisie] = useState('');
  const [q] = useDebouncedValue(saisie.trim(), 300);
  const [membres, setMembres] = useState<Map<string, Membre>>(new Map());
  const recherche = useGetMembres(
    { q, limite: 10 },
    { query: { enabled: cible === 'membres' && q.length >= 2 } },
  );
  const [confirmer, setConfirmer] = useState(false);
  const [diffusion, setDiffusion] = useState<Diffusion>();
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);

  const fermer = () => {
    setCible('tous');
    setChoixCategories([]);
    setMembres(new Map());
    setSaisie('');
    setConfirmer(false);
    setDiffusion(undefined);
    setErreur(undefined);
    onFermer();
  };
  if (!reunion) return null;
  const apercu = rendreModele(MODELES_NOTIFICATION.convocation.contenu, {
    'association.sigle': association,
    'reunion.titre': reunion.titre,
    'reunion.date': dateSms(reunion.debut),
    'reunion.lieu': reunion.lieu ?? '',
  });
  const valide = cible === 'tous' || (cible === 'categories' ? choixCategories.length > 0 : membres.size > 0);
  const envoyer = async () => {
    setEnCours(true);
    setErreur(undefined);
    try {
      const r = await postReunionsIdConvoquer(reunion.id!, {
        canaux: ['sms'],
        cible:
          cible === 'tous'
            ? { tous: true }
            : cible === 'categories'
              ? { categories: choixCategories }
              : { membres: [...membres.keys()] },
      });
      setDiffusion(r);
      setConfirmer(false);
      await client.invalidateQueries({ queryKey: getGetReunionsQueryKey() });
    } catch (e) {
      setErreur(e);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal
      opened
      onClose={fermer}
      title={t('reunions.convoquerTitre', { titre: reunion.titre })}
      centered
      size="lg"
    >
      <Stack>
        <Radio.Group label={t('reunions.cible')} value={cible} onChange={(v) => setCible(v as Cible)}>
          <Group mt="xs">
            <Radio value="tous" label={t('reunions.cibleTous')} />
            <Radio value="categories" label={t('reunions.cibleCategories')} />
            <Radio value="membres" label={t('reunions.cibleMembres')} />
          </Group>
        </Radio.Group>
        {cible === 'categories' && (
          <Checkbox.Group
            value={choixCategories}
            onChange={setChoixCategories}
            label={t('reunions.categories')}
          >
            <Stack gap={4} mt="xs">
              {(categories.data ?? []).map((c) => (
                <Checkbox key={c.id} value={c.id ?? ''} label={c.libelle} />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        {cible === 'membres' && (
          <Stack gap={4}>
            <TextInput
              label={t('campagnes.rechercherMembre')}
              type="search"
              value={saisie}
              onChange={(e) => setSaisie(e.currentTarget.value)}
            />
            {(recherche.data?.donnees ?? []).map((m) => (
              <Checkbox
                key={m.id}
                label={`${m.numero ?? ''} — ${nomMembre(m)}`}
                checked={membres.has(m.id)}
                onChange={() =>
                  setMembres((p) => {
                    const n = new Map(p);
                    if (n.has(m.id)) n.delete(m.id);
                    else n.set(m.id, m);
                    return n;
                  })
                }
              />
            ))}
            {membres.size > 0 && (
              <Text size="sm" fw={600}>
                {t('campagnes.membresChoisis', { n: membres.size })}
              </Text>
            )}
          </Stack>
        )}
        <Text size="sm" fw={500}>
          {t('reunions.apercu')}
        </Text>
        <ApercuSms texte={apercu} />
        <Text size="xs" c="dimmed">
          {t('reunions.apercuAide')}
        </Text>
        {erreur !== undefined && (
          <Alert color="red" role="alert">
            {messageErreur(erreur)}
          </Alert>
        )}
        <ResultatDiffusion diffusion={diffusion} />
        {confirmer && !diffusion && (
          <Alert color="orange">
            <Stack gap="xs">
              <Text size="sm">{t('reunions.confirmation')}</Text>
              <Group>
                <Button size="xs" variant="default" onClick={() => setConfirmer(false)}>
                  {t('commun.annuler')}
                </Button>
                <Button size="xs" loading={enCours} onClick={() => void envoyer()}>
                  {t('reunions.envoyerConvocations')}
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={fermer}>
            {t('commun.fermer')}
          </Button>
          {!diffusion && (
            <Button disabled={!valide || confirmer} onClick={() => setConfirmer(true)}>
              {t('reunions.convoquer')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

/** A19 (minimal, sprint 4) — Réunions : planification et convocation d'AG par SMS (E6-08, RF-063). */
export function Reunions() {
  const [curseurs, setCurseurs] = useState<string[]>([]);
  const liste = useGetReunions({ limite: 50, ...(curseurs.length ? { curseur: curseurs.at(-1) } : {}) });
  const [nouvelle, setNouvelle] = useState(false);
  const [convocation, setConvocation] = useState<Reunion>();

  const colonnes: Colonne<Reunion>[] = [
    { cle: 'titre', titre: t('reunions.colTitre'), rendu: (r) => r.titre },
    { cle: 'type', titre: t('reunions.colType'), rendu: (r) => libelleType(r.type) },
    { cle: 'debut', titre: t('reunions.colDebut'), rendu: (r) => formatDateHeure(r.debut) },
    { cle: 'lieu', titre: t('reunions.colLieu'), rendu: (r) => r.lieu ?? '—' },
    {
      cle: 'statut',
      titre: t('reunions.colStatut'),
      rendu: (r) => <BadgeStatut domaine="reunion" valeur={r.statut} />,
    },
    { cle: 'convoques', titre: t('reunions.colConvoques'), rendu: (r) => r.convoques ?? 0 },
    {
      cle: 'actions',
      titre: t('reunions.colActions'),
      rendu: (r) =>
        r.statut === 'planifiee' && new Date(r.debut).getTime() > Date.now() ? (
          <Button
            size="xs"
            variant="default"
            onClick={() => setConvocation(r)}
            aria-label={t('reunions.convoquerTitre', { titre: r.titre })}
          >
            {t('reunions.convoquer')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Stack gap="lg" maw={1240}>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('reunions.titre')}
        </Title>
        <Button onClick={() => setNouvelle(true)}>{t('reunions.nouvelle')}</Button>
      </Group>
      <TableauDonnees
        libelle={t('reunions.titre')}
        colonnes={colonnes}
        lignes={liste.data?.donnees}
        cleLigne={(r) => r.id ?? r.titre}
        chargement={liste.isPending}
        erreur={liste.error}
        messageVide={t('reunions.aucune')}
        pagination={{
          aPrecedente: curseurs.length > 0,
          precedente: () => setCurseurs((c) => c.slice(0, -1)),
          curseurSuivant: liste.data?.page.curseurSuivant,
          suivante: (c) => setCurseurs((p) => [...p, c]),
        }}
      />
      <NouvelleReunion ouvert={nouvelle} onFermer={() => setNouvelle(false)} />
      {convocation && <Convocation reunion={convocation} onFermer={() => setConvocation(undefined)} />}
    </Stack>
  );
}

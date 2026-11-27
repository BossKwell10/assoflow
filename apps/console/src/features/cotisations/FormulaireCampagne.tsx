import {
  campagneCreationSchema,
  formatMontant,
  genererPeriodes,
  type CampagneCreation,
} from '@assoflow/contracts';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  MultiSelect,
  NativeSelect,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  getGetCampagnesIdQueryKey,
  patchCampagnesId,
  postCampagnes,
  useGetCampagnesId,
} from '../../api/generated/cotisations/cotisations';
import type { Campagne, CampagneMaj } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { AlerteErreur } from '../../shared/AlerteErreur';
import { ChampMontant } from '../../shared/ChampMontant';
import { usePatchVersionne } from '../../shared/concurrence';
import { erreursDeChamps } from '../../shared/erreurs';
import { formatDate } from '../../shared/format';
import { uuidV7 } from '../../shared/uuid';
import { useReferentielsMembres } from '../membres/commun';
import {
  invaliderCotisations,
  libellePeriodicite,
  MOTIFS,
  PERIODICITES,
  useExercicesCotisation,
} from './commun';

type Valeurs = {
  exerciceId: string;
  libelle: string;
  type: 'ordinaire' | 'exceptionnelle';
  motif: string;
  montant: number | null;
  periodicite: (typeof PERIODICITES)[number];
  dateDebut: string;
  dateFin: string;
  jourEcheance: number;
  categoriesCibles: string[];
};

const valeursDe = (c?: Campagne, exerciceId = ''): Valeurs => ({
  exerciceId: c?.exerciceId ?? exerciceId,
  libelle: c?.libelle ?? '',
  type: c?.type ?? 'ordinaire',
  motif: c?.motif ?? '',
  montant: c?.montant ?? null,
  periodicite: c?.periodicite ?? 'mensuelle',
  dateDebut: c?.dateDebut ?? '',
  dateFin: c?.dateFin ?? '',
  jourEcheance: c?.jourEcheance ?? 5,
  categoriesCibles: c?.categoriesCibles ?? [],
});

const corpsDe = (v: Valeurs) => ({
  exerciceId: v.exerciceId,
  libelle: v.libelle.trim(),
  type: v.type,
  motif: v.type === 'exceptionnelle' ? ((v.motif || null) as CampagneCreation['motif']) : null,
  montant: v.montant ?? 0,
  periodicite: v.periodicite,
  dateDebut: v.dateDebut,
  dateFin: v.dateFin,
  jourEcheance: v.jourEcheance,
  categoriesCibles: v.categoriesCibles,
});

/** Champs modifiables selon le statut (RG-COT-001, RG-COT-013). */
const MODIFIABLES: Record<Campagne['statut'] & string, (keyof Valeurs)[] | 'tous'> = {
  brouillon: 'tous',
  active: ['libelle', 'dateFin', 'montant'],
  cloturee: ['libelle'],
};

/** Formulaire de campagne avec aperçu des périodes (écran A8, RF-030, RF-037). */
function Formulaire({ initial }: { initial?: Campagne }) {
  const client = useQueryClient();
  const naviguer = useNavigate();
  const exercices = useExercicesCotisation();
  const ref = useReferentielsMembres();
  const ouverts = exercices.liste.filter((e) => e.statut === 'ouvert');
  const [valeurs, setValeurs] = useState<Valeurs>(() => valeursDe(initial));
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);
  const [cle] = useState(() => uuidV7());
  const creation = !initial;
  const modifiables = MODIFIABLES[initial?.statut ?? 'brouillon'];
  const verrouille = (champ: keyof Valeurs) => modifiables !== 'tous' && !modifiables.includes(champ);
  const exerciceId = valeurs.exerciceId || ouverts[0]?.id || '';
  const exercice = exercices.exercice(exerciceId);

  const modification = usePatchVersionne(
    `/campagnes/${initial?.id}`,
    (corps: CampagneMaj, options: RequestInit) => patchCampagnesId(initial!.id!, corps, options),
    { etag: initial?.etag },
  );

  const maj = <K extends keyof Valeurs>(nom: K, v: Valeurs[K]) => setValeurs((p) => ({ ...p, [nom]: v }));
  const corps = corpsDe({ ...valeurs, exerciceId });
  const verif = campagneCreationSchema.safeParse(corps);
  const periodes =
    corps.dateDebut && corps.dateFin && corps.dateFin >= corps.dateDebut ? genererPeriodes(corps) : [];

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    if (!verif.success) {
      setErreurs(Object.fromEntries(verif.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErreurs({});
    setEnCours(true);
    setErreur(undefined);
    try {
      let campagne: Campagne;
      if (creation) {
        campagne = await postCampagnes(verif.data, { headers: { 'Idempotency-Key': cle } });
      } else {
        const avant = corpsDe(valeursDe(initial));
        const modifs = Object.fromEntries(
          Object.entries(verif.data).filter(
            ([k, v]) => JSON.stringify(v) !== JSON.stringify(avant[k as keyof typeof avant]),
          ),
        ) as CampagneMaj;
        campagne = Object.keys(modifs).length ? await modification.mutateAsync(modifs) : initial;
      }
      client.setQueryData(getGetCampagnesIdQueryKey(campagne.id!), campagne);
      await invaliderCotisations(client);
      void naviguer({ to: '/cotisations/campagnes/$id', params: { id: campagne.id! } });
    } catch (err) {
      setErreurs(erreursDeChamps(err));
      setErreur(err);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <form onSubmit={(e) => void soumettre(e)} noValidate>
      <Stack gap="lg">
        {Boolean(erreur) && <AlerteErreur erreur={erreur} />}
        {initial?.statut === 'active' && <Alert color="blue">{t('campagnes.modifActive')}</Alert>}
        <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NativeSelect
                label={t('campagnes.exercice')}
                value={exerciceId}
                disabled={verrouille('exerciceId')}
                onChange={(e) => maj('exerciceId', e.currentTarget.value)}
                data={ouverts.map((x) => ({ value: x.id ?? '', label: x.libelle }))}
                error={erreurs.exerciceId}
                description={
                  exercice ? `${formatDate(exercice.dateDebut)} → ${formatDate(exercice.dateFin)}` : undefined
                }
              />
              <TextInput
                label={t('campagnes.libelle')}
                required
                value={valeurs.libelle}
                onChange={(e) => maj('libelle', e.currentTarget.value)}
                error={erreurs.libelle}
              />
            </SimpleGrid>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('campagnes.type')}
              </Text>
              <SegmentedControl
                aria-label={t('campagnes.type')}
                disabled={verrouille('type')}
                value={valeurs.type}
                onChange={(v) => maj('type', v as Valeurs['type'])}
                data={[
                  { value: 'ordinaire', label: t('campagnes.typeOrdinaire') },
                  { value: 'exceptionnelle', label: t('campagnes.typeExceptionnelle') },
                ]}
              />
            </Stack>
            {valeurs.type === 'exceptionnelle' && (
              <NativeSelect
                label={t('campagnes.motif')}
                required
                disabled={verrouille('motif')}
                value={valeurs.motif}
                onChange={(e) => maj('motif', e.currentTarget.value)}
                data={[
                  { value: '', label: t('campagnes.choisir') },
                  ...MOTIFS.map((m) => ({ value: m, label: t(`campagnes.motif_${m}`) })),
                ]}
                error={erreurs.motif}
              />
            )}
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <ChampMontant
                label={t('campagnes.montant')}
                description={t('campagnes.montantAide')}
                required
                disabled={verrouille('montant')}
                value={valeurs.montant}
                onChange={(m) => maj('montant', m)}
                error={erreurs.montant}
              />
              <NativeSelect
                label={t('campagnes.periodicite')}
                disabled={verrouille('periodicite')}
                value={valeurs.periodicite}
                onChange={(e) => maj('periodicite', e.currentTarget.value as Valeurs['periodicite'])}
                data={PERIODICITES.map((p) => ({ value: p, label: libellePeriodicite(p) }))}
              />
              <NumberInput
                label={t('campagnes.jourEcheance')}
                disabled={verrouille('jourEcheance') || valeurs.periodicite === 'unique'}
                min={1}
                max={28}
                value={valeurs.jourEcheance}
                onChange={(v) => maj('jourEcheance', Number(v) || 5)}
              />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                type="date"
                label={t('campagnes.dateDebut')}
                required
                disabled={verrouille('dateDebut')}
                value={valeurs.dateDebut}
                onChange={(e) => maj('dateDebut', e.currentTarget.value)}
                error={erreurs.dateDebut}
              />
              <TextInput
                type="date"
                label={t('campagnes.dateFin')}
                required
                disabled={verrouille('dateFin')}
                value={valeurs.dateFin}
                onChange={(e) => maj('dateFin', e.currentTarget.value)}
                error={erreurs.dateFin}
              />
            </SimpleGrid>
            <MultiSelect
              label={t('campagnes.categoriesCibles')}
              description={t('campagnes.categoriesAide')}
              disabled={verrouille('categoriesCibles')}
              value={valeurs.categoriesCibles}
              onChange={(v) => maj('categoriesCibles', v)}
              data={ref.categories.map((c) => ({ value: c.id ?? '', label: c.libelle }))}
              error={erreurs.categoriesCibles}
              clearable
            />
          </Stack>
        </Card>

        <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
          <Stack gap={6} aria-label={t('campagnes.apercuPeriodes')} role="region">
            <Text fw={600}>{t('campagnes.apercuPeriodes')}</Text>
            {periodes.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('campagnes.apercuVide')}
              </Text>
            ) : (
              <>
                <Text size="sm">
                  {t('campagnes.apercuNombre', {
                    n: periodes.length,
                    montant: formatMontant((valeurs.montant ?? 0) * periodes.length),
                  })}
                </Text>
                <Text size="sm" c="dimmed">
                  {periodes
                    .slice(0, 3)
                    .map((p) => `${p.libelle} (${formatDate(p.dateEcheance)})`)
                    .join(' · ')}
                  {periodes.length > 3 ? ' …' : ''}
                </Text>
              </>
            )}
          </Stack>
        </Card>

        <Group>
          <Button type="submit" loading={enCours}>
            {creation ? t('campagnes.creer') : t('commun.enregistrer')}
          </Button>
          <Button
            component={Link}
            to={initial ? `/cotisations/campagnes/${initial.id}` : '/cotisations/campagnes'}
            variant="default"
          >
            {t('commun.annuler')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Création d'une campagne en brouillon (RG-COT-001). */
export function NouvelleCampagne() {
  return (
    <Stack gap="lg" maw={960}>
      <Anchor component={Link} to="/cotisations/campagnes" size="sm">
        ← {t('campagnes.retourListe')}
      </Anchor>
      <Title order={1} size={28}>
        {t('campagnes.nouvelle')}
      </Title>
      <Formulaire />
    </Stack>
  );
}

/** Modification d'une campagne (RG-COT-001 en brouillon, RG-COT-013 ensuite). */
export function ModificationCampagne() {
  const { id } = useParams({ strict: false }) as { id: string };
  const campagne = useGetCampagnesId(id, { query: { staleTime: 0 } });
  if (campagne.isPending) return null;
  if (campagne.isError) return <AlerteErreur erreur={campagne.error} />;
  return (
    <Stack gap="lg" maw={960}>
      <Anchor component={Link} to={`/cotisations/campagnes/${id}`} size="sm">
        ← {campagne.data.libelle}
      </Anchor>
      <Title order={1} size={28}>
        {t('campagnes.modifier')}
      </Title>
      <Formulaire initial={campagne.data} />
    </Stack>
  );
}

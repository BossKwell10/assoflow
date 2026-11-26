import {
  Alert,
  Anchor,
  Avatar,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  getGetAssociationQueryKey,
  patchAssociation,
  putAssociationLogo,
  useGetAssociation,
} from '../../api/generated/association/association';
import type { Association, AssociationMaj, AssociationType } from '../../api/generated/modeles';
import { usePermission, useSession } from '../../auth/SessionProvider';
import { t, type CleTexte } from '../../i18n';
import { AlerteErreur } from '../../shared/AlerteErreur';
import { ChampMontant } from '../../shared/ChampMontant';
import { ChampTelephone, lireTelephone } from '../../shared/ChampTelephone';
import { usePatchVersionne } from '../../shared/concurrence';
import { DepotFichier } from '../../shared/DepotFichier';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatTelephone } from '../../shared/format';

const TYPES: AssociationType[] = ['association', 'mutuelle_developpement', 'mutuelle_sociale', 'autre'];
const MOIS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];
const TYPES_LOGO = ['image/png', 'image/jpeg', 'image/webp'] as const;
const LOGO_MAX = 2 * 1024 * 1024;

const texte = (v: string) => v.trim() || null;

function Formulaire({ association: a, onRecharger }: { association: Association; onRecharger: () => void }) {
  const client = useQueryClient();
  const [v, setV] = useState({
    nom: a.nom,
    sigle: a.sigle ?? '',
    type: a.type ?? 'association',
    village: a.village,
    sousPrefecture: a.sousPrefecture ?? '',
    region: a.region,
    dateCreation: a.dateCreation ?? '',
    recepisseNumero: a.recepisseNumero ?? '',
    recepisseDate: a.recepisseDate ?? '',
    prefectureDepot: a.prefectureDepot ?? '',
    telephone: formatTelephone(a.telephone),
    email: a.email ?? '',
    moisDebutExercice: String(a.moisDebutExercice ?? 1),
    joursRetardDormant: String(a.joursRetardDormant ?? 180),
  });
  const [seuilDouble, setSeuilDouble] = useState<number | null>(a.seuilDoubleValidation ?? null);
  const [seuilSolde, setSeuilSolde] = useState<number | null>(a.seuilAlerteSolde ?? null);
  const [journal, setJournal] = useState(a.journalPublicActif ?? false);
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [succes, setSucces] = useState<string>();
  const [logoEnCours, setLogoEnCours] = useState(false);

  // RG-ASS-003 : le seuil de double validation n'est modifiable que par le président (403 sinon).
  const president = useSession().associationActive?.role.code === 'president';
  const modification = usePatchVersionne(
    '/association',
    (corps: AssociationMaj, options: RequestInit) => patchAssociation(corps, options),
    { etag: a.etag },
  );

  const champ = (nom: keyof typeof v) => ({
    value: v[nom],
    error: erreurs[nom],
    onChange: (e: { currentTarget: { value: string } }) => {
      const valeur = e.currentTarget.value;
      setV((p) => ({ ...p, [nom]: valeur }));
    },
  });

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    const nouvelles: Record<string, string> = {};
    for (const c of ['nom', 'village', 'region'] as const)
      if (!v[c].trim()) nouvelles[c] = t('connexion.champRequis');
    const telephone = lireTelephone(v.telephone);
    if (telephone === undefined) nouvelles.telephone = t('connexion.telephoneInvalide');
    const jours = Number(v.joursRetardDormant);
    if (!Number.isInteger(jours) || jours < 1) nouvelles.joursRetardDormant = t('association.joursInvalides');
    setErreurs(nouvelles);
    if (Object.keys(nouvelles).length) return;

    const corps: AssociationMaj = {
      nom: v.nom.trim(),
      sigle: texte(v.sigle),
      type: v.type as AssociationType,
      village: v.village.trim(),
      sousPrefecture: texte(v.sousPrefecture),
      region: v.region.trim(),
      dateCreation: v.dateCreation || null,
      recepisseNumero: texte(v.recepisseNumero),
      recepisseDate: v.recepisseDate || null,
      prefectureDepot: texte(v.prefectureDepot),
      telephone: telephone ?? null,
      email: texte(v.email),
      moisDebutExercice: Number(v.moisDebutExercice),
      seuilDoubleValidation: president ? (seuilDouble ?? undefined) : undefined,
      seuilAlerteSolde: seuilSolde ?? undefined,
      joursRetardDormant: jours,
      journalPublicActif: journal,
    };
    const modifs = Object.fromEntries(
      Object.entries(corps).filter(
        ([cle, valeur]) => (a as unknown as Record<string, unknown>)[cle] !== valeur,
      ),
    ) as AssociationMaj;
    setErreur(undefined);
    setSucces(undefined);
    if (!Object.keys(modifs).length) {
      setSucces(t('association.aucuneModification'));
      return;
    }
    try {
      const maj = await modification.mutateAsync(modifs);
      client.setQueryData(getGetAssociationQueryKey(), maj);
      setSucces(t('association.enregistreOk'));
    } catch (err) {
      setErreurs(erreursDeChamps(err));
      setErreur(err);
    }
  };

  const changerLogo = async (fichier: File) => {
    setLogoEnCours(true);
    setErreur(undefined);
    try {
      const maj = await putAssociationLogo({ fichier });
      client.setQueryData(getGetAssociationQueryKey(), maj);
      setSucces(t('association.logoOk'));
    } catch (err) {
      setErreur(err);
    } finally {
      setLogoEnCours(false);
    }
  };

  const carte = { withBorder: true, radius: 12, padding: 'lg', style: { borderColor: '#E3E6EA' } } as const;

  return (
    <form onSubmit={(e) => void soumettre(e)} noValidate>
      <Stack gap="lg">
        {Boolean(erreur) && <AlerteErreur erreur={erreur} onRecharger={onRecharger} />}
        <div role="status" aria-live="polite">
          {succes && (
            <Text c="#1B6B34" size="sm">
              {succes}
            </Text>
          )}
        </div>

        <Card {...carte}>
          <Stack>
            <Text fw={600}>{t('association.sectionIdentite')}</Text>
            <Group align="flex-end">
              <Avatar src={a.logoUrl ?? undefined} size={64} radius="md" alt={t('association.logo')}>
                {a.nom.charAt(0)}
              </Avatar>
              <DepotFichier
                label={t('association.logo')}
                types={TYPES_LOGO}
                tailleMax={LOGO_MAX}
                enCours={logoEnCours}
                onFichier={(f) => void changerLogo(f)}
              />
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label={t('association.nom')} required {...champ('nom')} />
              <TextInput label={t('association.sigle')} {...champ('sigle')} />
              <NativeSelect
                label={t('association.type')}
                data={TYPES.map((ty) => ({ value: ty, label: t(`association.types.${ty}` as CleTexte) }))}
                {...champ('type')}
              />
              <TextInput type="date" label={t('association.dateCreation')} {...champ('dateCreation')} />
              <TextInput label={t('association.village')} required {...champ('village')} />
              <TextInput label={t('association.sousPrefecture')} {...champ('sousPrefecture')} />
              <TextInput label={t('association.region')} required {...champ('region')} />
            </SimpleGrid>
          </Stack>
        </Card>

        <Card {...carte}>
          <Stack>
            <Text fw={600}>{t('association.sectionLegal')}</Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput label={t('association.recepisseNumero')} {...champ('recepisseNumero')} />
              <TextInput type="date" label={t('association.recepisseDate')} {...champ('recepisseDate')} />
              <TextInput label={t('association.prefectureDepot')} {...champ('prefectureDepot')} />
            </SimpleGrid>
          </Stack>
        </Card>

        <Card {...carte}>
          <Stack>
            <Text fw={600}>{t('association.sectionCoordonnees')}</Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <ChampTelephone
                label={t('membres.colTelephone')}
                value={v.telephone}
                error={erreurs.telephone}
                onChange={(tel) => setV((p) => ({ ...p, telephone: tel }))}
              />
              <TextInput type="email" label={t('membres.email')} {...champ('email')} />
            </SimpleGrid>
          </Stack>
        </Card>

        <Card {...carte}>
          <Stack>
            <Text fw={600}>{t('association.sectionSeuils')}</Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <ChampMontant
                label={t('association.seuilDoubleValidation')}
                description={t(
                  president ? 'association.seuilDoubleValidationAide' : 'association.seuilPresidentSeul',
                )}
                disabled={!president}
                value={seuilDouble}
                onChange={setSeuilDouble}
                error={erreurs.seuilDoubleValidation}
              />
              <ChampMontant
                label={t('association.seuilAlerteSolde')}
                value={seuilSolde}
                onChange={setSeuilSolde}
                error={erreurs.seuilAlerteSolde}
              />
              <TextInput
                type="number"
                min={1}
                label={t('association.joursRetardDormant')}
                description={t('association.joursRetardDormantAide')}
                {...champ('joursRetardDormant')}
              />
              <NativeSelect
                label={t('association.moisDebutExercice')}
                data={MOIS.map((m, i) => ({ value: String(i + 1), label: m }))}
                {...champ('moisDebutExercice')}
              />
              <TextInput
                label={t('association.devise')}
                value="XOF (FCFA)"
                readOnly
                description={t('association.deviseAide')}
              />
            </SimpleGrid>
            <Checkbox
              label={t('association.journalPublic')}
              checked={journal}
              onChange={(e) => setJournal(e.currentTarget.checked)}
            />
          </Stack>
        </Card>

        <Group justify="flex-end">
          <Button type="submit" loading={modification.isPending}>
            {t('commun.enregistrer')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** A27 — Paramètres › Association (RF-010, RF-011, RF-ADM-020, RF-ADM-024). */
export function ParametresAssociation() {
  const association = useGetAssociation();
  const peutModifier = usePermission('association.modifier');
  // Le formulaire repart des données du serveur seulement sur demande (après un 412), jamais en arrière-plan.
  const [version, setVersion] = useState(0);
  return (
    <Stack gap="lg" maw={960}>
      <Anchor component={Link} to="/parametres" size="sm">
        ← {t('parametres.titre')}
      </Anchor>
      <Title order={1} size={28}>
        {t('association.titre')}
      </Title>
      {association.isPending && (
        <Center p="xl">
          <Loader aria-label={t('commun.chargement')} />
        </Center>
      )}
      {association.isError && (
        <Alert color="red" role="alert">
          {messageErreur(association.error)}
        </Alert>
      )}
      {association.data && peutModifier && (
        <Formulaire
          key={version}
          association={association.data}
          onRecharger={() => void association.refetch().then(() => setVersion((n) => n + 1))}
        />
      )}
    </Stack>
  );
}

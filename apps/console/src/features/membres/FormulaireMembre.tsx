import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  NativeSelect,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  getGetMembresIdQueryKey,
  patchMembresId,
  postMembres,
  putMembresIdPhoto,
  useGetMembresId,
} from '../../api/generated/membres/membres';
import type { Famille, Membre, MembreMaj } from '../../api/generated/modeles';
import { estErreurApi } from '../../api/erreurs';
import { Si } from '../../auth/Si';
import { t, type CleTexte } from '../../i18n';
import { AlerteErreur } from '../../shared/AlerteErreur';
import { ChampTelephone, lireTelephone } from '../../shared/ChampTelephone';
import { usePatchVersionne } from '../../shared/concurrence';
import { DepotFichier } from '../../shared/DepotFichier';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatTelephone } from '../../shared/format';
import { uuidV7 } from '../../shared/uuid';
import { Chargement, invaliderMembres, nomMembre, PAYS, useReferentielsMembres } from './commun';
import { CreationFamille } from './Familles';

const TYPES_PHOTO = ['image/jpeg', 'image/png', 'image/webp'] as const;
const PHOTO_MAX = 2 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Valeurs {
  nom: string;
  prenoms: string;
  sexe: string;
  dateNaissance: string;
  telephone: string;
  telephoneWhatsapp: boolean;
  email: string;
  villageOrigine: string;
  lieuResidence: string;
  paysResidence: string;
  categorieId: string;
  familleId: string;
  statutAdhesion: string;
  dateAdhesion: string;
  canalPrefere: string;
  notes: string;
}

const aujourdhui = () => new Date().toISOString().slice(0, 10);

const valeursDe = (m?: Membre): Valeurs => ({
  nom: m?.nom ?? '',
  prenoms: m?.prenoms ?? '',
  sexe: m?.sexe ?? '',
  dateNaissance: m?.dateNaissance ?? '',
  telephone: formatTelephone(m?.telephone),
  telephoneWhatsapp: m?.telephoneWhatsapp ?? false,
  email: m?.email ?? '',
  villageOrigine: m?.villageOrigine ?? '',
  lieuResidence: m?.lieuResidence ?? '',
  paysResidence: m?.paysResidence ?? 'CI',
  categorieId: m?.categorieId ?? '',
  familleId: m?.familleId ?? '',
  statutAdhesion: m?.statutAdhesion ?? 'actif',
  dateAdhesion: m?.dateAdhesion ?? (m ? '' : aujourdhui()),
  canalPrefere: m?.canalPrefere ?? 'sms',
  notes: m?.notes ?? '',
});

const ouNull = (v: string) => v.trim() || null;

/** Corps `MembreMaj` (mêmes champs que la création, sans les champs serveur). */
function corpsDe(v: Valeurs): MembreMaj {
  return {
    nom: v.nom.trim(),
    prenoms: v.prenoms.trim(),
    sexe: (v.sexe || null) as MembreMaj['sexe'],
    dateNaissance: v.dateNaissance || null,
    telephone: lireTelephone(v.telephone) ?? null,
    telephoneWhatsapp: v.telephoneWhatsapp,
    email: ouNull(v.email),
    villageOrigine: ouNull(v.villageOrigine),
    lieuResidence: ouNull(v.lieuResidence),
    paysResidence: v.paysResidence,
    categorieId: v.categorieId || null,
    familleId: v.familleId || null,
    statutAdhesion: v.statutAdhesion as MembreMaj['statutAdhesion'],
    canalPrefere: v.canalPrefere as MembreMaj['canalPrefere'],
    notes: ouNull(v.notes),
  };
}

/** PATCH : seuls les champs modifiés sont envoyés (docs/07 §2). */
function differences(avant: MembreMaj, apres: MembreMaj): MembreMaj {
  return Object.fromEntries(
    Object.entries(apres).filter(([cle, valeur]) => avant[cle as keyof MembreMaj] !== valeur),
  ) as MembreMaj;
}

function Formulaire({ initial, onRecharger }: { initial?: Membre; onRecharger?: () => void }) {
  const client = useQueryClient();
  const naviguer = useNavigate();
  const ref = useReferentielsMembres();
  const creation = !initial;
  // UUIDv7 généré une fois par formulaire : clé d'idempotence de la création (docs/07 §5).
  const [id] = useState(() => initial?.id ?? uuidV7());
  const [valeurs, setValeurs] = useState<Valeurs>(() => valeursDe(initial));
  const [consentement, setConsentement] = useState(false);
  const [canalConsentement, setCanalConsentement] = useState<'console' | 'papier'>('papier');
  const [photo, setPhoto] = useState<File>();
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);
  // RG-MBR-003 : fiche existante signalée par 422 CONFIRMATION_REQUISE (`erreurs[0].ref`).
  const [doublonDe, setDoublonDe] = useState<string | null>();
  // La création confirmée malgré le doublon a un corps différent : clé d'idempotence distincte.
  const [cleConfirmation] = useState(() => uuidV7());
  const [familleRapide, setFamilleRapide] = useState(false);
  const [famillesCreees, setFamillesCreees] = useState<Famille[]>([]);

  const modification = usePatchVersionne(
    `/membres/${id}`,
    (corps: MembreMaj, options: RequestInit) => patchMembresId(id, corps, options),
    { etag: initial?.etag },
  );

  const champ = <K extends keyof Valeurs>(nom: K) => ({
    value: valeurs[nom] as string,
    error: erreurs[nom],
    onChange: (e: { currentTarget: { value: string } }) => {
      const v = e.currentTarget.value;
      setValeurs((p) => ({ ...p, [nom]: v }));
    },
  });

  const sansContact = !valeurs.telephone.trim() && !valeurs.familleId;
  const familles = [
    ...ref.familles,
    ...famillesCreees.filter((f) => !ref.familles.some((r) => r.id === f.id)),
  ];

  const valider = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!valeurs.nom.trim()) e.nom = t('connexion.champRequis');
    if (!valeurs.prenoms.trim()) e.prenoms = t('connexion.champRequis');
    if (lireTelephone(valeurs.telephone) === undefined) e.telephone = t('connexion.telephoneInvalide');
    if (valeurs.email.trim() && !EMAIL.test(valeurs.email.trim())) e.email = t('membres.emailInvalide');
    if (sansContact) e.contact = t('membres.rgMbr002');
    if (creation && !consentement) e.consentement = t('membres.consentementRequis');
    return e;
  };

  const terminer = async (membre: Membre) => {
    client.setQueryData(getGetMembresIdQueryKey(membre.id), membre);
    await invaliderMembres(client);
    void naviguer({ to: '/membres/$id', params: { id: membre.id } });
  };

  const soumettre = async (e: FormEvent | undefined, confirmationDoublon = false) => {
    e?.preventDefault();
    const nouvelles = valider();
    setErreurs(nouvelles);
    if (Object.keys(nouvelles).length) return;
    setEnCours(true);
    setErreur(undefined);
    setDoublonDe(undefined);
    try {
      const corps = corpsDe(valeurs);
      let membre: Membre;
      if (creation) {
        membre = await postMembres(
          {
            id,
            ...corps,
            sexe: corps.sexe ?? null,
            nom: corps.nom!,
            prenoms: corps.prenoms!,
            dateAdhesion: valeurs.dateAdhesion || undefined,
            consentement: { traitementDonnees: true, canal: canalConsentement },
            ...(confirmationDoublon ? { confirmationDoublon: true } : {}),
          },
          { headers: { 'Idempotency-Key': confirmationDoublon ? cleConfirmation : id } },
        );
      } else {
        const modifs = differences(corpsDe(valeursDe(initial)), corps);
        membre = Object.keys(modifs).length ? await modification.mutateAsync(modifs) : initial;
      }
      if (photo) membre = await putMembresIdPhoto(membre.id, { fichier: photo });
      await terminer(membre);
    } catch (err) {
      if (estErreurApi(err) && err.code === 'CONFIRMATION_REQUISE') {
        setDoublonDe(err.probleme.erreurs?.find((x) => x.ref)?.ref ?? null);
        return;
      }
      setErreurs(erreursDeChamps(err));
      setErreur(err);
    } finally {
      setEnCours(false);
    }
  };

  const options = (prefixe: string, valeursPossibles: string[]) =>
    valeursPossibles.map((v) => ({ value: v, label: t(`${prefixe}.${v}` as CleTexte) }));

  return (
    <>
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack gap="lg">
          {Boolean(erreur) && <AlerteErreur erreur={erreur} onRecharger={onRecharger} />}
          {doublonDe !== undefined && (
            <Alert color="orange" role="alert" title={t('membres.doublonTitre')}>
              <Stack gap="sm" align="flex-start">
                <Text size="sm">
                  {t('membres.doublonMessage', { nom: `${valeurs.nom.trim()} ${valeurs.prenoms.trim()}` })}
                </Text>
                <Group gap="sm">
                  {doublonDe && (
                    <Button component={Link} to={`/membres/${doublonDe}`} variant="default">
                      {t('membres.voirFiche')}
                    </Button>
                  )}
                  <Button loading={enCours} onClick={() => void soumettre(undefined, true)}>
                    {t('membres.enregistrerQuandMeme')}
                  </Button>
                </Group>
              </Stack>
            </Alert>
          )}

          <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
            <Stack>
              <Text fw={600}>{t('membres.sectionIdentite')}</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label={t('membres.nom')} required {...champ('nom')} data-autofocus />
                <TextInput label={t('membres.prenoms')} required {...champ('prenoms')} />
                <NativeSelect
                  label={t('membres.sexe')}
                  data={[
                    { value: '', label: '—' },
                    { value: 'F', label: t('membres.sexeF') },
                    { value: 'M', label: t('membres.sexeM') },
                  ]}
                  {...champ('sexe')}
                />
                <TextInput type="date" label={t('membres.dateNaissance')} {...champ('dateNaissance')} />
              </SimpleGrid>
            </Stack>
          </Card>

          <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
            <Stack>
              <Text fw={600}>{t('membres.sectionContact')}</Text>
              {sansContact && (
                <Alert
                  color={erreurs.contact ? 'red' : 'orange'}
                  role={erreurs.contact ? 'alert' : undefined}
                >
                  {t('membres.rgMbr002')}
                </Alert>
              )}
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Stack gap={6}>
                  <ChampTelephone
                    label={t('membres.colTelephone')}
                    value={valeurs.telephone}
                    error={erreurs.telephone}
                    onChange={(v) => setValeurs((p) => ({ ...p, telephone: v }))}
                  />
                  <Checkbox
                    label={t('membres.whatsapp')}
                    checked={valeurs.telephoneWhatsapp}
                    onChange={(e) => {
                      const coche = e.currentTarget.checked;
                      setValeurs((p) => ({ ...p, telephoneWhatsapp: coche }));
                    }}
                  />
                </Stack>
                <TextInput type="email" label={t('membres.email')} {...champ('email')} />
                <TextInput label={t('membres.villageOrigine')} {...champ('villageOrigine')} />
                <TextInput label={t('membres.lieuResidence')} {...champ('lieuResidence')} />
                <NativeSelect
                  label={t('membres.paysResidence')}
                  data={PAYS.map((p) => ({ value: p.code, label: p.nom }))}
                  {...champ('paysResidence')}
                />
                <NativeSelect
                  label={t('membres.canalPrefere')}
                  data={options('canaux', ['sms', 'whatsapp', 'push', 'aucun'])}
                  {...champ('canalPrefere')}
                />
              </SimpleGrid>
            </Stack>
          </Card>

          <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
            <Stack>
              <Text fw={600}>{t('membres.sectionAdhesion')}</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <NativeSelect
                  label={t('membres.colCategorie')}
                  data={[
                    { value: '', label: '—' },
                    ...ref.categories
                      .filter((c) => c.id && c.actif !== false)
                      .map((c) => ({ value: c.id!, label: c.libelle })),
                  ]}
                  {...champ('categorieId')}
                />
                <Stack gap={6}>
                  <NativeSelect
                    label={t('membres.colFamille')}
                    data={[
                      { value: '', label: '—' },
                      ...familles.filter((f) => f.id).map((f) => ({ value: f.id!, label: f.nom })),
                    ]}
                    {...champ('familleId')}
                  />
                  <Si permission="membre.creer">
                    <Anchor component="button" type="button" size="sm" onClick={() => setFamilleRapide(true)}>
                      {t('familles.creationRapide')}
                    </Anchor>
                  </Si>
                </Stack>
                <NativeSelect
                  label={t('membres.filtreStatut')}
                  data={options('statutsMembre', ['actif', 'dormant', 'honoraire', 'bienfaiteur'])}
                  {...champ('statutAdhesion')}
                />
                <TextInput
                  type="date"
                  label={t('membres.dateAdhesion')}
                  disabled={!creation}
                  {...champ('dateAdhesion')}
                />
              </SimpleGrid>
              <Textarea label={t('membres.notes')} rows={3} {...champ('notes')} />
              <DepotFichier
                label={t('membres.photo')}
                types={TYPES_PHOTO}
                tailleMax={PHOTO_MAX}
                onFichier={setPhoto}
              />
            </Stack>
          </Card>

          {creation && (
            <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
              <Stack>
                <Checkbox
                  label={t('membres.consentement')}
                  required
                  checked={consentement}
                  error={erreurs.consentement}
                  onChange={(e) => setConsentement(e.currentTarget.checked)}
                />
                <Radio.Group
                  label={t('membres.canalConsentement')}
                  value={canalConsentement}
                  onChange={(v) => setCanalConsentement(v as 'console' | 'papier')}
                >
                  <Group mt={4}>
                    <Radio value="papier" label={t('membres.consentementPapier')} />
                    <Radio value="console" label={t('membres.consentementConsole')} />
                  </Group>
                </Radio.Group>
              </Stack>
            </Card>
          )}

          <Group justify="flex-end">
            <Button variant="default" component={Link} to={creation ? '/membres' : `/membres/${id}`}>
              {t('commun.annuler')}
            </Button>
            <Button type="submit" loading={enCours}>
              {t('commun.enregistrer')}
            </Button>
          </Group>
        </Stack>
      </form>
      {familleRapide && (
        <CreationFamille
          onFermer={() => setFamilleRapide(false)}
          onCree={(f) => {
            setFamillesCreees((p) => [...p, f]);
            setValeurs((p) => ({ ...p, familleId: f.id ?? '' }));
          }}
        />
      )}
    </>
  );
}

/** A4 — Nouveau membre (RF-020 à 022). */
export function NouveauMembre() {
  return (
    <Stack gap="lg" maw={960}>
      <Anchor component={Link} to="/membres" size="sm">
        ← {t('membres.retourListe')}
      </Anchor>
      <Title order={1} size={28}>
        {t('membres.nouveau')}
      </Title>
      <Formulaire />
    </Stack>
  );
}

/** A4 — Modifier un membre : `PATCH` avec `If-Match`, 412 si la fiche a changé entre-temps. */
export function ModificationMembre() {
  const { id } = useParams({ strict: false }) as { id: string };
  const membre = useGetMembresId(id);
  // Le formulaire repart des données du serveur seulement sur demande (après un 412), jamais en arrière-plan.
  const [version, setVersion] = useState(0);
  if (membre.isPending) return <Chargement />;
  if (membre.isError)
    return (
      <Alert color="red" role="alert" maw={720}>
        {messageErreur(membre.error)}
      </Alert>
    );
  return (
    <Stack gap="lg" maw={960}>
      <Anchor component={Link} to={`/membres/${id}`} size="sm">
        ← {nomMembre(membre.data)}
      </Anchor>
      <Title order={1} size={28}>
        {t('membres.modificationTitre', { nom: nomMembre(membre.data) })}
      </Title>
      <Formulaire
        key={version}
        initial={membre.data}
        onRecharger={() => void membre.refetch().then(() => setVersion((n) => n + 1))}
      />
    </Stack>
  );
}

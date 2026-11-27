import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Modal,
  NativeSelect,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  patchFamillesId,
  postFamilles,
  useGetFamilles,
  useGetFamillesIdMembres,
} from '../../api/generated/membres/membres';
import type { Famille, Membre } from '../../api/generated/modeles';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { Montant } from '../../shared/Montant';
import { BadgeStatut, Statut } from '../../shared/Statut';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import { uuidV7 } from '../../shared/uuid';
import type { RechercheFamilles } from './recherche';
import { Chargement, invaliderMembres, nomMembre, TAILLE_PAGE, useAffichageTelephone } from './commun';

/** Création (rapide depuis A4) ou modification d'une famille. */
export function CreationFamille({
  initial,
  membres = [],
  onFermer,
  onCree,
}: {
  initial?: Famille;
  membres?: Membre[];
  onFermer: () => void;
  onCree: (f: Famille) => void;
}) {
  const client = useQueryClient();
  const [id] = useState(() => initial?.id ?? uuidV7());
  const [nom, setNom] = useState(initial?.nom ?? '');
  const [village, setVillage] = useState(initial?.villageOrigine ?? '');
  const [chef, setChef] = useState(initial?.chefFamilleId ?? '');
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!nom.trim()) {
      setErreurs({ nom: t('connexion.champRequis') });
      return;
    }
    setEnCours(true);
    setErreur(undefined);
    try {
      const corps: Famille = {
        nom: nom.trim(),
        villageOrigine: village.trim() || null,
        ...(initial ? { chefFamilleId: chef || null } : {}),
      };
      const famille = initial?.id
        ? await patchFamillesId(initial.id, corps)
        : await postFamilles({ id, ...corps });
      await invaliderMembres(client);
      onCree(famille);
      onFermer();
    } catch (err) {
      setErreurs(erreursDeChamps(err));
      setErreur(err);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal
      opened
      onClose={onFermer}
      title={initial ? t('familles.modificationTitre') : t('familles.creationTitre')}
      centered
    >
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack>
          {Boolean(erreur) && (
            <Alert color="red" role="alert">
              {messageErreur(erreur)}
            </Alert>
          )}
          <TextInput
            label={t('familles.nom')}
            required
            value={nom}
            error={erreurs.nom}
            onChange={(e) => setNom(e.currentTarget.value)}
            data-autofocus
          />
          <TextInput
            label={t('membres.villageOrigine')}
            value={village}
            onChange={(e) => setVillage(e.currentTarget.value)}
          />
          {initial && (
            <NativeSelect
              label={t('familles.chef')}
              description={t('familles.chefAide')}
              value={chef}
              error={erreurs.chefFamilleId}
              onChange={(e) => setChef(e.currentTarget.value)}
              data={[
                { value: '', label: '—' },
                ...membres.map((m) => ({ value: m.id, label: nomMembre(m) })),
              ]}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onFermer}>
              {t('commun.annuler')}
            </Button>
            <Button type="submit" loading={enCours}>
              {t('commun.enregistrer')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** A5 — Familles (RF-021, RF-038). */
export function ListeFamilles() {
  const { recherche, modifier, curseur, pagination } = useRechercheTableau<RechercheFamilles>();
  const [saisie, setSaisie] = useState(recherche.q ?? '');
  const [creation, setCreation] = useState(false);
  const rechercher = useDebouncedCallback((q: string) => modifier({ q: q.trim() || undefined }), 300);
  const liste = useGetFamilles({
    limite: TAILLE_PAGE,
    ...(recherche.q ? { q: recherche.q } : {}),
    ...(curseur ? { curseur } : {}),
  });

  const colonnes: Colonne<Famille>[] = [
    {
      cle: 'nom',
      titre: t('familles.nom'),
      rendu: (f) =>
        f.id ? (
          <Anchor component={Link} to={`/membres/familles/${f.id}`} fw={500}>
            {f.nom}
          </Anchor>
        ) : (
          f.nom
        ),
    },
    { cle: 'village', titre: t('membres.villageOrigine'), rendu: (f) => f.villageOrigine ?? '' },
    { cle: 'membres', titre: t('familles.nombreMembres'), rendu: (f) => f.nombreMembres ?? 0 },
  ];

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/membres" size="sm">
        ← {t('membres.retourListe')}
      </Anchor>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('familles.titre')}
        </Title>
        <Si permission="membre.creer">
          <Button onClick={() => setCreation(true)}>{t('familles.nouvelle')}</Button>
        </Si>
      </Group>
      <TextInput
        label={t('familles.rechercher')}
        type="search"
        maw={480}
        value={saisie}
        onChange={(e) => {
          setSaisie(e.currentTarget.value);
          rechercher(e.currentTarget.value);
        }}
      />
      <TableauDonnees
        libelle={t('familles.titre')}
        colonnes={colonnes}
        lignes={liste.data?.donnees}
        cleLigne={(f) => f.id ?? f.nom}
        chargement={liste.isPending}
        erreur={liste.error}
        pagination={{ ...pagination, curseurSuivant: liste.data?.page.curseurSuivant }}
        messageVide={t('familles.aucune')}
        largeurMin={600}
      />
      {creation && <CreationFamille onFermer={() => setCreation(false)} onCree={() => undefined} />}
    </Stack>
  );
}

/** A5 — Fiche famille : membres, chef de famille, reste dû cumulé. */
export function FicheFamille() {
  const { id } = useParams({ strict: false }) as { id: string };
  const familles = useGetFamilles({ limite: 200 });
  const membres = useGetFamillesIdMembres(id);
  const telephone = useAffichageTelephone();
  const [edition, setEdition] = useState(false);

  if (membres.isPending || familles.isPending) return <Chargement />;
  if (membres.isError)
    return (
      <Alert color="red" role="alert" maw={720}>
        {messageErreur(membres.error)}
      </Alert>
    );
  // Le contrat n'expose pas `GET /familles/{id}` : la famille est retrouvée dans la liste (écart signalé).
  const famille = familles.data?.donnees.find((f) => f.id === id);
  const liste = membres.data;
  // Reste dû cumulé : somme des soldes négatifs des membres (solde = payé − exigible).
  const resteDu = liste.reduce((total, m) => total + Math.max(0, -(m.soldeCotisations ?? 0)), 0);

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/membres/familles" size="sm">
        ← {t('familles.titre')}
      </Anchor>
      <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <Title order={1} size={26}>
              {famille?.nom ?? t('familles.titre')}
            </Title>
            {famille?.villageOrigine && <Text c="dimmed">{famille.villageOrigine}</Text>}
          </Stack>
          <Group gap="sm">
            {famille && (
              <Si permission="paiement.enregistrer">
                <Button
                  component={Link}
                  to="/cotisations/paiements/saisie"
                  search={{ familleId: id } as never}
                >
                  {t('familles.paiementGroupe')}
                </Button>
              </Si>
            )}
            {famille && (
              <Si permission="membre.modifier">
                <Button variant="default" onClick={() => setEdition(true)}>
                  {t('membres.modifier')}
                </Button>
              </Si>
            )}
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg">
          <div>
            <Text size="sm" c="dimmed">
              {t('familles.nombreMembres')}
            </Text>
            <Text fw={600} size="lg">
              {liste.length}
            </Text>
          </div>
          <div>
            <Text size="sm" c="dimmed">
              {t('familles.resteDuCumule')}
            </Text>
            <Montant valeur={resteDu} size="lg" c={resteDu ? '#A11B1B' : undefined} />
          </div>
        </SimpleGrid>
      </Card>

      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        {liste.length === 0 ? (
          <Text c="dimmed" p="lg">
            {t('familles.aucunMembre')}
          </Text>
        ) : (
          <Table verticalSpacing="sm" horizontalSpacing="md" aria-label={t('familles.membres')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('membres.colNumero')}</Table.Th>
                <Table.Th>{t('membres.colNom')}</Table.Th>
                <Table.Th>{t('membres.colTelephone')}</Table.Th>
                <Table.Th>{t('membres.colEtat')}</Table.Th>
                <Table.Th>{t('membres.colSolde')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {liste.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>{m.numero}</Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      <Anchor component={Link} to={`/membres/${m.id}`}>
                        {nomMembre(m)}
                      </Anchor>
                      {famille?.chefFamilleId === m.id && <Statut ton="neutre">{t('familles.chef')}</Statut>}
                    </Group>
                  </Table.Td>
                  <Table.Td>{telephone(m.telephone)}</Table.Td>
                  <Table.Td>
                    <BadgeStatut domaine="membreEtat" valeur={m.etat} />
                  </Table.Td>
                  <Table.Td>
                    <Montant valeur={m.soldeCotisations ?? 0} size="sm" />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
      {edition && famille && (
        <CreationFamille
          initial={famille}
          membres={liste}
          onFermer={() => setEdition(false)}
          onCree={() => undefined}
        />
      )}
    </Stack>
  );
}

import {
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useGetMembres, useGetMembresDoublons } from '../../api/generated/membres/membres';
import type { GetMembresParams, GetMembresTri, Membre } from '../../api/generated/modeles';
import { Si } from '../../auth/Si';
import { t } from '../../i18n';
import { telechargerFichier, versCsv, type ColonneCsv } from '../../shared/csv';
import { formatDate } from '../../shared/format';
import { Montant } from '../../shared/Montant';
import { BadgeStatut } from '../../shared/Statut';
import { useRechercheTableau } from '../../shared/rechercheUrl';
import { TableauDonnees, type Colonne } from '../../shared/TableauDonnees';
import type { RechercheMembres } from './recherche';
import { nomMembre, TAILLE_PAGE, useAffichageTelephone, useReferentielsMembres } from './commun';

const DELAI_RECHERCHE = 300;

/** A2 — Membres (RF-025, RF-039). */
export function ListeMembres() {
  const { recherche, modifier, curseur, pagination, trier } = useRechercheTableau<RechercheMembres>();
  const telephone = useAffichageTelephone();
  const ref = useReferentielsMembres();
  const doublons = useGetMembresDoublons({ query: { staleTime: 60_000 } });
  const [saisie, setSaisie] = useState(recherche.q ?? '');
  const rechercher = useDebouncedCallback(
    (q: string) => modifier({ q: q.trim() || undefined }),
    DELAI_RECHERCHE,
  );

  const parametres: GetMembresParams = {
    q: recherche.q,
    statutAdhesion: recherche.statutAdhesion,
    etat: recherche.etat,
    categorieId: recherche.categorieId,
    familleId: recherche.familleId,
    diaspora: recherche.diaspora,
    enRetard: recherche.enRetard,
    tri: recherche.tri as GetMembresTri | undefined,
    limite: TAILLE_PAGE,
    curseur,
  };
  const liste = useGetMembres(
    Object.fromEntries(Object.entries(parametres).filter(([, v]) => v !== undefined)) as GetMembresParams,
  );
  const nombreDoublons = doublons.data?.length ?? 0;
  const filtresActifs = Boolean(
    recherche.q ||
    recherche.statutAdhesion ||
    recherche.etat ||
    recherche.categorieId ||
    recherche.familleId ||
    recherche.diaspora ||
    recherche.enRetard,
  );

  const colonnes: Colonne<Membre>[] = [
    { cle: 'numero', titre: t('membres.colNumero'), rendu: (m) => m.numero ?? '—', tri: { asc: 'numero' } },
    {
      cle: 'nom',
      titre: t('membres.colNom'),
      tri: { asc: 'nom', desc: '-nom' },
      rendu: (m) => (
        <Anchor component={Link} to={`/membres/${m.id}`} fw={500}>
          {nomMembre(m)}
        </Anchor>
      ),
    },
    { cle: 'telephone', titre: t('membres.colTelephone'), rendu: (m) => telephone(m.telephone) },
    { cle: 'categorie', titre: t('membres.colCategorie'), rendu: (m) => ref.libelleCategorie(m.categorieId) },
    { cle: 'famille', titre: t('membres.colFamille'), rendu: (m) => ref.famille(m.familleId)?.nom ?? '' },
    {
      cle: 'statut',
      titre: t('membres.colStatut'),
      rendu: (m) => <BadgeStatut domaine="membreAdhesion" valeur={m.statutAdhesion} />,
    },
    {
      cle: 'etat',
      titre: t('membres.colEtat'),
      rendu: (m) => <BadgeStatut domaine="membreEtat" valeur={m.etat} />,
    },
    {
      cle: 'solde',
      titre: t('membres.colSolde'),
      tri: { asc: 'soldeCotisations' },
      rendu: (m) => <Montant valeur={m.soldeCotisations ?? 0} size="sm" />,
    },
    {
      cle: 'app',
      titre: t('membres.colAccesApp'),
      rendu: (m) => (
        <Text size="sm" c={m.aAccesApp ? '#1B6B34' : 'dimmed'}>
          <span aria-hidden>{m.aAccesApp ? '● ' : '○ '}</span>
          {m.aAccesApp ? t('commun.oui') : t('commun.non')}
        </Text>
      ),
    },
  ];

  const colonnesCsv: ColonneCsv<Membre>[] = [
    { titre: t('membres.colNumero'), valeur: (m) => m.numero },
    { titre: t('membres.nom'), valeur: (m) => m.nom },
    { titre: t('membres.prenoms'), valeur: (m) => m.prenoms },
    { titre: t('membres.colTelephone'), valeur: (m) => (m.telephone ? telephone(m.telephone) : '') },
    { titre: t('membres.colCategorie'), valeur: (m) => ref.libelleCategorie(m.categorieId) },
    { titre: t('membres.colFamille'), valeur: (m) => ref.famille(m.familleId)?.nom },
    { titre: t('membres.colStatut'), valeur: (m) => m.statutAdhesion },
    { titre: t('membres.colEtat'), valeur: (m) => m.etat },
    { titre: t('membres.dateAdhesion'), valeur: (m) => formatDate(m.dateAdhesion) },
    { titre: t('membres.colSolde'), valeur: (m) => m.soldeCotisations ?? 0 },
  ];

  const selecteur = (
    cle: 'statutAdhesion' | 'etat' | 'categorieId' | 'familleId',
    label: string,
    options: { value: string; label: string }[],
    tous = t('membres.filtreTous'),
  ) => (
    <NativeSelect
      label={label}
      value={recherche[cle] ?? ''}
      onChange={(e) => modifier({ [cle]: e.currentTarget.value || undefined })}
      data={[{ value: '', label: tous }, ...options]}
    />
  );

  return (
    <Stack gap="lg" maw={1240}>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('membres.titre')}
        </Title>
        <Group gap="sm">
          <Button component={Link} to="/membres/familles" variant="default">
            {t('membres.familles')}
          </Button>
          {nombreDoublons > 0 && (
            <Button component={Link} to="/membres/doublons" variant="default">
              {t('membres.doublons', { n: nombreDoublons })}
            </Button>
          )}
          <Si permission="membre.importer">
            <Button component={Link} to="/membres/import" variant="default">
              {t('membres.importer')}
            </Button>
          </Si>
          <Si permission="membre.creer">
            <Button component={Link} to="/membres/nouveau">
              {t('membres.nouveau')}
            </Button>
          </Si>
        </Group>
      </Group>

      <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
        <Stack gap="sm">
          <TextInput
            label={t('membres.rechercher')}
            description={t('membres.rechercherAide')}
            type="search"
            value={saisie}
            onChange={(e) => {
              setSaisie(e.currentTarget.value);
              rechercher(e.currentTarget.value);
            }}
          />
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            {selecteur('statutAdhesion', t('membres.filtreStatut'), [
              { value: 'actif', label: t('statutsMembre.actif') },
              { value: 'dormant', label: t('statutsMembre.dormant') },
              { value: 'honoraire', label: t('statutsMembre.honoraire') },
              { value: 'bienfaiteur', label: t('statutsMembre.bienfaiteur') },
            ])}
            {selecteur(
              'etat',
              t('membres.filtreEtat'),
              [
                { value: 'actif', label: t('etatsMembre.actif') },
                { value: 'suspendu', label: t('etatsMembre.suspendu') },
                { value: 'desactive', label: t('etatsMembre.desactive') },
              ],
              t('membres.filtreEtatDefaut'),
            )}
            {selecteur(
              'categorieId',
              t('membres.filtreCategorie'),
              ref.categories.filter((c) => c.id).map((c) => ({ value: c.id!, label: c.libelle })),
            )}
            {selecteur(
              'familleId',
              t('membres.filtreFamille'),
              ref.familles.filter((f) => f.id).map((f) => ({ value: f.id!, label: f.nom })),
            )}
          </SimpleGrid>
          <Group gap="lg">
            <Checkbox
              label={t('membres.filtreDiaspora')}
              checked={recherche.diaspora === true}
              onChange={(e) => modifier({ diaspora: e.currentTarget.checked || undefined })}
            />
            <Checkbox
              label={t('membres.filtreEnRetard')}
              checked={recherche.enRetard === true}
              onChange={(e) => modifier({ enRetard: e.currentTarget.checked || undefined })}
            />
            {filtresActifs && (
              <Button
                variant="subtle"
                onClick={() => {
                  setSaisie('');
                  modifier({
                    q: undefined,
                    statutAdhesion: undefined,
                    etat: undefined,
                    categorieId: undefined,
                    familleId: undefined,
                    diaspora: undefined,
                    enRetard: undefined,
                  });
                }}
              >
                {t('membres.reinitialiserFiltres')}
              </Button>
            )}
          </Group>
        </Stack>
      </Card>

      <TableauDonnees
        libelle={t('membres.titre')}
        colonnes={colonnes}
        lignes={liste.data?.donnees}
        cleLigne={(m) => m.id}
        libelleLigne={nomMembre}
        chargement={liste.isPending}
        erreur={liste.error}
        tri={recherche.tri}
        onTri={trier}
        pagination={{ ...pagination, curseurSuivant: liste.data?.page.curseurSuivant }}
        messageVide={filtresActifs ? t('membres.aucunResultat') : t('membres.aucunMembre')}
        actionsSelection={(selection) => (
          <Button
            size="xs"
            variant="default"
            mih={36}
            onClick={() =>
              telechargerFichier(
                `membres-${new Date().toISOString().slice(0, 10)}.csv`,
                versCsv(colonnesCsv, selection),
              )
            }
          >
            {t('membres.exporterSelection')}
          </Button>
        )}
      />
    </Stack>
  );
}

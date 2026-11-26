import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  NativeSelect,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  getGetCategoriesDepenseQueryKey,
  patchCategoriesDepenseId,
  postCategoriesDepense,
  useGetCategoriesDepense,
} from '../../api/generated/depenses/depenses';
import {
  getGetCategoriesMembresQueryKey,
  patchCategoriesMembresId,
  postCategoriesMembres,
  useGetCategoriesMembres,
} from '../../api/generated/membres/membres';
import type { CategorieDepense, CategorieDepenseNature, CategorieMembre } from '../../api/generated/modeles';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t, type CleTexte } from '../../i18n';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { BadgeStatut } from '../../shared/Statut';

const NATURES: CategorieDepenseNature[] = ['fonctionnement', 'projet', 'aide_sociale', 'autre'];
const libelleNature = (n: string) => t(`categories.natures.${n}` as CleTexte);

type Categorie = {
  id?: string;
  libelle: string;
  actif?: boolean;
  description?: string | null;
  nature?: string;
};

/** Création ou modification d'une catégorie (membres : description ; dépenses : nature). */
function FormulaireCategorie({
  type,
  initial,
  onFermer,
  onEnregistre,
}: {
  type: 'membres' | 'depenses';
  initial?: Categorie;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const [libelle, setLibelle] = useState(initial?.libelle ?? '');
  const [complement, setComplement] = useState(
    type === 'membres' ? (initial?.description ?? '') : (initial?.nature ?? 'fonctionnement'),
  );
  const [actif, setActif] = useState(initial?.actif ?? true);
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    if (!libelle.trim()) {
      setErreurs({ libelle: t('connexion.champRequis') });
      return;
    }
    setEnCours(true);
    setErreur(undefined);
    try {
      if (type === 'membres') {
        const corps: CategorieMembre = {
          libelle: libelle.trim(),
          description: complement.trim() || null,
          actif,
        };
        if (initial?.id) await patchCategoriesMembresId(initial.id, corps);
        else await postCategoriesMembres(corps);
      } else {
        const corps: CategorieDepense = {
          libelle: libelle.trim(),
          nature: complement as CategorieDepenseNature,
          actif,
        };
        if (initial?.id) await patchCategoriesDepenseId(initial.id, corps);
        else await postCategoriesDepense(corps);
      }
      onEnregistre();
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
      title={initial ? t('categories.modificationTitre') : t('categories.creationTitre')}
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
            label={t('categories.libelle')}
            required
            value={libelle}
            error={erreurs.libelle}
            onChange={(e) => setLibelle(e.currentTarget.value)}
            data-autofocus
          />
          {type === 'membres' ? (
            <TextInput
              label={t('categories.description')}
              value={complement}
              onChange={(e) => setComplement(e.currentTarget.value)}
            />
          ) : (
            <NativeSelect
              label={t('categories.nature')}
              value={complement}
              onChange={(e) => setComplement(e.currentTarget.value)}
              data={NATURES.map((n) => ({ value: n, label: libelleNature(n) }))}
            />
          )}
          <Checkbox
            label={t('categories.active')}
            checked={actif}
            onChange={(e) => setActif(e.currentTarget.checked)}
          />
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

function ListeCategories({
  type,
  requete,
  colonne,
  onRafraichir,
}: {
  type: 'membres' | 'depenses';
  requete: UseQueryResult<Categorie[], unknown>;
  colonne: { titre: string; rendu: (c: Categorie) => ReactNode };
  onRafraichir: () => Promise<unknown>;
}) {
  const peutModifier = useAuMoinsUnePermission('association.modifier');
  const [edition, setEdition] = useState<Categorie | 'nouvelle'>();
  const [succes, setSucces] = useState<string>();

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
        {peutModifier && <Button onClick={() => setEdition('nouvelle')}>{t('categories.nouvelle')}</Button>}
      </Group>
      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        {requete.isPending && (
          <Text p="lg" c="dimmed">
            {t('commun.chargement')}
          </Text>
        )}
        {requete.isError && (
          <Alert color="red" role="alert" m="md">
            {messageErreur(requete.error)}
          </Alert>
        )}
        {requete.data && requete.data.length === 0 && (
          <Text p="lg" c="dimmed">
            {t('commun.aucuneDonnee')}
          </Text>
        )}
        {requete.data && requete.data.length > 0 && (
          <Table verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('categories.libelle')}</Table.Th>
                <Table.Th>{colonne.titre}</Table.Th>
                <Table.Th>{t('utilisateurs.colStatut')}</Table.Th>
                {peutModifier && <Table.Th>{t('utilisateurs.colActions')}</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {requete.data.map((c) => (
                <Table.Tr key={c.id ?? c.libelle}>
                  <Table.Td fw={500}>{c.libelle}</Table.Td>
                  <Table.Td>{colonne.rendu(c)}</Table.Td>
                  <Table.Td>
                    <BadgeStatut domaine="activation" valeur={c.actif === false ? 'inactif' : 'actif'} />
                  </Table.Td>
                  {peutModifier && (
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="default"
                        mih={36}
                        aria-label={t('categories.modifierAria', { libelle: c.libelle })}
                        onClick={() => setEdition(c)}
                      >
                        {t('membres.modifier')}
                      </Button>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
      {edition && (
        <FormulaireCategorie
          type={type}
          initial={edition === 'nouvelle' ? undefined : edition}
          onFermer={() => setEdition(undefined)}
          onEnregistre={() => {
            setSucces(t('categories.enregistreOk'));
            void onRafraichir();
          }}
        />
      )}
    </Stack>
  );
}

/** A29 — Catégories de membres et de dépenses (RF-013, RF-ADM-021). */
export function Categories() {
  const client = useQueryClient();
  const lireDepenses = useAuMoinsUnePermission('depense.lire');
  const membres = useGetCategoriesMembres();
  const depenses = useGetCategoriesDepense({ query: { enabled: lireDepenses } });

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/parametres" size="sm">
        ← {t('parametres.titre')}
      </Anchor>
      <Title order={1} size={28}>
        {t('categories.titre')}
      </Title>
      <Tabs defaultValue="membres" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="membres">{t('categories.ongletMembres')}</Tabs.Tab>
          {lireDepenses && <Tabs.Tab value="depenses">{t('categories.ongletDepenses')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="membres" pt="lg">
          <ListeCategories
            type="membres"
            requete={membres}
            colonne={{ titre: t('categories.description'), rendu: (c) => c.description ?? '' }}
            onRafraichir={() => client.invalidateQueries({ queryKey: getGetCategoriesMembresQueryKey() })}
          />
        </Tabs.Panel>
        {lireDepenses && (
          <Tabs.Panel value="depenses" pt="lg">
            <ListeCategories
              type="depenses"
              requete={depenses}
              colonne={{
                titre: t('categories.nature'),
                rendu: (c) => (c.nature ? libelleNature(c.nature) : ''),
              }}
              onRafraichir={() => client.invalidateQueries({ queryKey: getGetCategoriesDepenseQueryKey() })}
            />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  );
}

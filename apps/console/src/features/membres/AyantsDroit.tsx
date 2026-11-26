import {
  Alert,
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
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  deleteMembresIdAyantsDroitAyantDroitId,
  getGetMembresIdAyantsDroitQueryKey,
  patchMembresIdAyantsDroitAyantDroitId,
  postMembresIdAyantsDroit,
  useGetMembresIdAyantsDroit,
} from '../../api/generated/membres/membres';
import type { AyantDroit, AyantDroitLien } from '../../api/generated/modeles';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t, type CleTexte } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatDate } from '../../shared/format';
import { uuidV7 } from '../../shared/uuid';
import { Chargement } from './commun';

const LIENS: AyantDroitLien[] = ['conjoint', 'enfant', 'parent', 'autre'];
const nomAyantDroit = (a: AyantDroit) => `${a.nom} ${a.prenoms}`;

function FormulaireAyantDroit({
  membreId,
  initial,
  onFermer,
  onEnregistre,
}: {
  membreId: string;
  initial?: AyantDroit;
  onFermer: () => void;
  onEnregistre: (a: AyantDroit) => void;
}) {
  const [valeurs, setValeurs] = useState({
    nom: initial?.nom ?? '',
    prenoms: initial?.prenoms ?? '',
    lien: initial?.lien ?? '',
    dateNaissance: initial?.dateNaissance ?? '',
  });
  // Identifiant fourni par le client : un nouvel essai après coupure ne crée pas de doublon (docs/07 §5).
  const [id] = useState(() => initial?.id ?? uuidV7());
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);
  const champ = (nom: keyof typeof valeurs) => ({
    value: valeurs[nom],
    error: erreurs[nom],
    onChange: (e: { currentTarget: { value: string } }) => {
      const v = e.currentTarget.value;
      setValeurs((p) => ({ ...p, [nom]: v }));
    },
  });

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    const manquants = Object.fromEntries(
      (['nom', 'prenoms', 'lien'] as const)
        .filter((c) => !valeurs[c].trim())
        .map((c) => [c, t('connexion.champRequis')]),
    );
    setErreurs(manquants);
    if (Object.keys(manquants).length) return;
    const corps: AyantDroit = {
      nom: valeurs.nom.trim(),
      prenoms: valeurs.prenoms.trim(),
      lien: valeurs.lien as AyantDroitLien,
      dateNaissance: valeurs.dateNaissance || null,
    };
    setEnCours(true);
    setErreur(undefined);
    try {
      const resultat = initial?.id
        ? await patchMembresIdAyantsDroitAyantDroitId(membreId, initial.id, corps)
        : await postMembresIdAyantsDroit(membreId, { id, ...corps });
      onEnregistre(resultat);
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
      title={initial ? t('ayantsDroit.modificationTitre') : t('ayantsDroit.ajoutTitre')}
      centered
    >
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack>
          {Boolean(erreur) && (
            <Alert color="red" role="alert">
              {messageErreur(erreur)}
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('membres.nom')} required {...champ('nom')} data-autofocus />
            <TextInput label={t('membres.prenoms')} required {...champ('prenoms')} />
          </SimpleGrid>
          <NativeSelect
            label={t('ayantsDroit.lien')}
            required
            data={[
              { value: '', label: '—' },
              ...LIENS.map((l) => ({ value: l, label: t(`ayantsDroit.liens.${l}` as CleTexte) })),
            ]}
            {...champ('lien')}
          />
          <TextInput type="date" label={t('membres.dateNaissance')} {...champ('dateNaissance')} />
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

/** Onglet Ayants droit (RF-028) : ajout, modification, retrait. */
export function AyantsDroit({ membreId }: { membreId: string }) {
  const client = useQueryClient();
  const liste = useGetMembresIdAyantsDroit(membreId);
  const peutModifier = useAuMoinsUnePermission('membre.modifier');
  const [edition, setEdition] = useState<AyantDroit | 'nouveau'>();
  const [retrait, setRetrait] = useState<AyantDroit>();
  const [succes, setSucces] = useState<string>();
  const rafraichir = () =>
    client.invalidateQueries({ queryKey: getGetMembresIdAyantsDroitQueryKey(membreId) });

  if (liste.isPending) return <Chargement />;
  if (liste.isError)
    return (
      <Alert color="red" role="alert">
        {messageErreur(liste.error)}
      </Alert>
    );

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
        {peutModifier && <Button onClick={() => setEdition('nouveau')}>{t('ayantsDroit.ajouter')}</Button>}
      </Group>
      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        {liste.data.length === 0 ? (
          <Text c="dimmed" p="lg">
            {t('ayantsDroit.aucun')}
          </Text>
        ) : (
          <Table verticalSpacing="sm" horizontalSpacing="md" aria-label={t('membres.ongletAyantsDroit')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('membres.colNom')}</Table.Th>
                <Table.Th>{t('ayantsDroit.lien')}</Table.Th>
                <Table.Th>{t('membres.dateNaissance')}</Table.Th>
                {peutModifier && <Table.Th>{t('utilisateurs.colActions')}</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {liste.data.map((a) => (
                <Table.Tr key={a.id ?? nomAyantDroit(a)}>
                  <Table.Td fw={500}>{nomAyantDroit(a)}</Table.Td>
                  <Table.Td>{t(`ayantsDroit.liens.${a.lien}` as CleTexte)}</Table.Td>
                  <Table.Td>{formatDate(a.dateNaissance)}</Table.Td>
                  {peutModifier && (
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="default"
                          mih={36}
                          aria-label={t('ayantsDroit.modifierAria', { nom: nomAyantDroit(a) })}
                          onClick={() => setEdition(a)}
                        >
                          {t('membres.modifier')}
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          color="red.9"
                          mih={36}
                          aria-label={t('ayantsDroit.retirerAria', { nom: nomAyantDroit(a) })}
                          onClick={() => setRetrait(a)}
                        >
                          {t('ayantsDroit.retirer')}
                        </Button>
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      {edition && (
        <FormulaireAyantDroit
          membreId={membreId}
          initial={edition === 'nouveau' ? undefined : edition}
          onFermer={() => setEdition(undefined)}
          onEnregistre={(a) => {
            setSucces(t('ayantsDroit.enregistreOk', { nom: nomAyantDroit(a) }));
            void rafraichir();
          }}
        />
      )}
      <ConfirmationAction
        ouvert={Boolean(retrait)}
        onFermer={() => setRetrait(undefined)}
        titre={t('ayantsDroit.retraitTitre')}
        resume={retrait && t('ayantsDroit.retraitResume', { nom: nomAyantDroit(retrait) })}
        libelleConfirmer={t('ayantsDroit.retirer')}
        danger
        onConfirmer={async () => {
          if (!retrait?.id) return;
          await deleteMembresIdAyantsDroitAyantDroitId(membreId, retrait.id);
          setSucces(t('ayantsDroit.retraitOk', { nom: nomAyantDroit(retrait) }));
          await rafraichir();
        }}
      />
    </Stack>
  );
}

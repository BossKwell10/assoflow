import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  getGetExercicesQueryKey,
  postExercices,
  postExercicesIdCloturer,
  useGetExercices,
} from '../../api/generated/association/association';
import type { Exercice } from '../../api/generated/modeles';
import { estErreurApi } from '../../api/erreurs';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatDate, formatDateHeure } from '../../shared/format';
import { BadgeStatut } from '../../shared/Statut';

const jourSuivant = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
/** Fin par défaut : 12 mois après le début, moins un jour (RG-EXE-001). */
const finParDefaut = (debut: string) => {
  const d = new Date(`${debut}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** RG-EXE-003 : message explicite quand des dépenses soumises ou validées bloquent la clôture. */
function messageCloture(erreur: unknown): string {
  if (estErreurApi(erreur) && erreur.code === 'DEPENSES_EN_COURS') {
    const detail = erreur.probleme.detail;
    return detail ? `${t('exercices.depensesEnCours')} ${detail}` : t('exercices.depensesEnCours');
  }
  return messageErreur(erreur);
}

function CreationExercice({
  exercices,
  onFermer,
  onCree,
}: {
  exercices: Exercice[];
  onFermer: () => void;
  onCree: (e: Exercice) => void;
}) {
  const dernier = [...exercices].sort((a, b) => b.dateFin.localeCompare(a.dateFin))[0];
  const debutDefaut = dernier ? jourSuivant(dernier.dateFin) : `${new Date().getUTCFullYear()}-01-01`;
  const [v, setV] = useState({
    libelle: debutDefaut.slice(0, 4),
    dateDebut: debutDefaut,
    dateFin: finParDefaut(debutDefaut),
  });
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);
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
    for (const c of ['libelle', 'dateDebut', 'dateFin'] as const)
      if (!v[c].trim()) nouvelles[c] = t('connexion.champRequis');
    if (!nouvelles.dateFin && !nouvelles.dateDebut && v.dateFin <= v.dateDebut)
      nouvelles.dateFin = t('exercices.finAvantDebut');
    setErreurs(nouvelles);
    if (Object.keys(nouvelles).length) return;
    setEnCours(true);
    setErreur(undefined);
    try {
      onCree(await postExercices({ libelle: v.libelle.trim(), dateDebut: v.dateDebut, dateFin: v.dateFin }));
      onFermer();
    } catch (err) {
      setErreurs(erreursDeChamps(err));
      setErreur(err);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal opened onClose={onFermer} title={t('exercices.creationTitre')} centered>
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t('exercices.creationAide')}
          </Text>
          {Boolean(erreur) && (
            <Alert color="red" role="alert">
              {messageErreur(erreur)}
            </Alert>
          )}
          <TextInput label={t('exercices.libelle')} required {...champ('libelle')} data-autofocus />
          <Group grow>
            <TextInput type="date" label={t('exercices.debut')} required {...champ('dateDebut')} />
            <TextInput type="date" label={t('exercices.fin')} required {...champ('dateFin')} />
          </Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={onFermer}>
              {t('commun.annuler')}
            </Button>
            <Button type="submit" loading={enCours}>
              {t('exercices.creer')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** A28 — Exercices (RF-014, RF-ADM-022, RG-EXE-001 à 003). */
export function Exercices() {
  const client = useQueryClient();
  const exercices = useGetExercices();
  const peutCreer = useAuMoinsUnePermission('exercice.gerer');
  const peutCloturer = useAuMoinsUnePermission('exercice.cloturer');
  const [creation, setCreation] = useState(false);
  const [cloture, setCloture] = useState<Exercice>();
  const [succes, setSucces] = useState<string>();
  const rafraichir = () => client.invalidateQueries({ queryKey: getGetExercicesQueryKey() });
  const liste = [...(exercices.data ?? [])].sort((a, b) => b.dateDebut.localeCompare(a.dateDebut));

  return (
    <Stack gap="lg" maw={1240}>
      <Anchor component={Link} to="/parametres" size="sm">
        ← {t('parametres.titre')}
      </Anchor>
      <Group justify="space-between" align="flex-end">
        <Title order={1} size={28}>
          {t('exercices.titre')}
        </Title>
        {peutCreer && <Button onClick={() => setCreation(true)}>{t('exercices.nouveau')}</Button>}
      </Group>
      <div role="status" aria-live="polite">
        {succes && (
          <Text c="#1B6B34" size="sm">
            {succes}
          </Text>
        )}
      </div>
      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        {exercices.isPending && (
          <Text p="lg" c="dimmed">
            {t('commun.chargement')}
          </Text>
        )}
        {exercices.isError && (
          <Alert color="red" role="alert" m="md">
            {messageErreur(exercices.error)}
          </Alert>
        )}
        {exercices.data && liste.length === 0 && (
          <Text p="lg" c="dimmed">
            {t('exercices.aucun')}
          </Text>
        )}
        {liste.length > 0 && (
          <Table verticalSpacing="sm" horizontalSpacing="md" aria-label={t('exercices.titre')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('exercices.libelle')}</Table.Th>
                <Table.Th>{t('exercices.debut')}</Table.Th>
                <Table.Th>{t('exercices.fin')}</Table.Th>
                <Table.Th>{t('utilisateurs.colStatut')}</Table.Th>
                <Table.Th>{t('exercices.clotureLe')}</Table.Th>
                {peutCloturer && <Table.Th>{t('utilisateurs.colActions')}</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {liste.map((e) => (
                <Table.Tr key={e.id ?? e.libelle}>
                  <Table.Td fw={500}>{e.libelle}</Table.Td>
                  <Table.Td>{formatDate(e.dateDebut)}</Table.Td>
                  <Table.Td>{formatDate(e.dateFin)}</Table.Td>
                  <Table.Td>
                    <BadgeStatut domaine="exercice" valeur={e.statut} />
                  </Table.Td>
                  <Table.Td>{formatDateHeure(e.clotureAt)}</Table.Td>
                  {peutCloturer && (
                    <Table.Td>
                      {e.statut === 'ouvert' && (
                        <Button
                          size="xs"
                          variant="outline"
                          color="red.9"
                          mih={36}
                          aria-label={t('exercices.cloturerAria', { libelle: e.libelle })}
                          onClick={() => setCloture(e)}
                        >
                          {t('exercices.cloturer')}
                        </Button>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      {creation && (
        <CreationExercice
          exercices={exercices.data ?? []}
          onFermer={() => setCreation(false)}
          onCree={(e) => {
            setSucces(t('exercices.creeOk', { libelle: e.libelle }));
            void rafraichir();
          }}
        />
      )}
      <ConfirmationAction
        ouvert={Boolean(cloture)}
        onFermer={() => setCloture(undefined)}
        titre={t('exercices.clotureTitre')}
        resume={
          cloture &&
          t('exercices.clotureResume', {
            libelle: cloture.libelle,
            debut: formatDate(cloture.dateDebut),
            fin: formatDate(cloture.dateFin),
          })
        }
        libelleConfirmer={t('exercices.cloturer')}
        danger
        messageErreur={messageCloture}
        onConfirmer={async () => {
          if (!cloture?.id) return;
          await postExercicesIdCloturer(cloture.id);
          setSucces(t('exercices.clotureOk', { libelle: cloture.libelle }));
          await rafraichir();
        }}
      />
    </Stack>
  );
}

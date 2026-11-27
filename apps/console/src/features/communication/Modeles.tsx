import {
  calculerSms,
  EXEMPLE_VARIABLES,
  rendreModele,
  variablesInconnues,
  estCodeModele,
} from '@assoflow/contracts';
import { Alert, Badge, Button, Group, Modal, Stack, Table, Text, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  deleteModelesNotificationCodeCanal,
  getGetModelesNotificationQueryKey,
  putModelesNotificationCodeCanal,
  useGetModelesNotification,
} from '../../api/generated/communication/communication';
import type { ModeleNotification } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { ApercuSms } from '../../shared/ApercuSms';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { Statut } from '../../shared/Statut';

/** Édition d'un modèle : variables cliquables insérées au curseur, aperçu avec un membre fictif. */
function EditionModele({ modele, onFermer }: { modele?: ModeleNotification; onFermer: () => void }) {
  const client = useQueryClient();
  const [contenu, setContenu] = useState(modele?.contenu ?? '');
  const [erreur, setErreur] = useState<unknown>();
  const [enCours, setEnCours] = useState(false);
  const zone = useRef<HTMLTextAreaElement>(null);
  if (!modele) return null;

  const inserer = (variable: string) => {
    const el = zone.current;
    const jeton = `{{${variable}}}`;
    const debut = el?.selectionStart ?? contenu.length;
    const fin = el?.selectionEnd ?? contenu.length;
    setContenu(contenu.slice(0, debut) + jeton + contenu.slice(fin));
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(debut + jeton.length, debut + jeton.length);
    });
  };
  // Contrôle local (RF-SUP-042 : on personnalise le texte, pas les variables) ; le serveur revérifie.
  const inconnues = estCodeModele(modele.code ?? '') ? variablesInconnues(modele.code as never, contenu) : [];
  const enregistrer = async () => {
    setEnCours(true);
    setErreur(undefined);
    try {
      await putModelesNotificationCodeCanal(modele.code!, modele.canal!, { contenu });
      await client.invalidateQueries({ queryKey: getGetModelesNotificationQueryKey() });
      onFermer();
    } catch (e) {
      setErreur(e);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal
      opened
      onClose={onFermer}
      title={t('modeles.editionTitre', { libelle: modele.libelle ?? '' })}
      size="lg"
      centered
    >
      <Stack>
        <Textarea
          ref={zone}
          label={t('modeles.texte')}
          rows={4}
          value={contenu}
          onChange={(e) => setContenu(e.currentTarget.value)}
          error={
            erreursDeChamps(erreur).contenu ??
            (inconnues.length
              ? t('modeles.variablesInconnues', { variables: inconnues.join(', ') })
              : undefined)
          }
        />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t('modeles.variables')}
          </Text>
          <Group gap={6}>
            {(modele.variables ?? []).map((v) => (
              <Button
                key={v}
                size="compact-xs"
                variant="light"
                onClick={() => inserer(v)}
                aria-label={t('modeles.inserer', { variable: v })}
              >
                {`{{${v}}}`}
              </Button>
            ))}
          </Group>
        </Stack>
        <Text size="sm" fw={500}>
          {t('modeles.apercu')}
        </Text>
        <ApercuSms texte={rendreModele(contenu, EXEMPLE_VARIABLES)} />
        {erreur !== undefined && (
          <Alert color="red" role="alert">
            {messageErreur(erreur)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onFermer}>
            {t('commun.annuler')}
          </Button>
          <Button loading={enCours} disabled={!contenu.trim()} onClick={() => void enregistrer()}>
            {t('modeles.enregistrer')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A21 — Modèles de messages : globaux, personnalisés par l'association (RF-ADM-023, RF-SUP-042). */
export function Modeles() {
  const client = useQueryClient();
  const liste = useGetModelesNotification();
  const [edition, setEdition] = useState<ModeleNotification>();
  const [retour, setRetour] = useState<ModeleNotification>();

  if (liste.isError)
    return (
      <Alert color="red" role="alert">
        {messageErreur(liste.error)}
      </Alert>
    );
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('modeles.aide')}
      </Text>
      <Table aria-label={t('communication.ongletModeles')} verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('modeles.colModele')}</Table.Th>
            <Table.Th>{t('modeles.colTexte')}</Table.Th>
            <Table.Th>{t('modeles.colUnites')}</Table.Th>
            <Table.Th>{t('modeles.colActions')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(liste.data ?? []).map((m) => (
            <Table.Tr key={`${m.code}-${m.canal}`}>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm" fw={600}>
                    {m.libelle ?? m.code}
                  </Text>
                  <Group gap={4}>
                    <Badge variant="light" size="xs">
                      {m.canal}
                    </Badge>
                    {m.personnalise && <Statut ton="attente">{t('modeles.personnalise')}</Statut>}
                  </Group>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{m.contenu}</Text>
              </Table.Td>
              <Table.Td>{m.unites ?? calculerSms(m.contenu).unites}</Table.Td>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => setEdition(m)}
                    aria-label={t('modeles.modifier', { libelle: m.libelle ?? m.code ?? '' })}
                  >
                    {t('commun.modifier')}
                  </Button>
                  {m.personnalise && (
                    <Button size="xs" variant="subtle" onClick={() => setRetour(m)}>
                      {t('modeles.revenirGlobal')}
                    </Button>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {edition && (
        <EditionModele
          key={`${edition.code}-${edition.canal}`}
          modele={edition}
          onFermer={() => setEdition(undefined)}
        />
      )}
      <ConfirmationAction
        ouvert={retour !== undefined}
        onFermer={() => setRetour(undefined)}
        titre={t('modeles.revenirGlobal')}
        resume={t('modeles.revenirResume', { texte: retour?.contenuGlobal ?? '' })}
        libelleConfirmer={t('modeles.revenirGlobal')}
        onConfirmer={async () => {
          await deleteModelesNotificationCodeCanal(retour!.code!, retour!.canal!);
          await client.invalidateQueries({ queryKey: getGetModelesNotificationQueryKey() });
        }}
      />
    </Stack>
  );
}

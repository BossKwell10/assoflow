import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { messageErreur } from './erreurs';

const MOTIF_MIN = 3;

/**
 * Boîte de confirmation des actions irréversibles (docs/08 §2, §7) : rappelle l'objet,
 * motif obligatoire si demandé, erreur de l'API affichée sans fermer la boîte.
 */
export function ConfirmationAction({
  ouvert,
  onFermer,
  titre,
  resume,
  libelleConfirmer,
  motifRequis = false,
  danger = false,
  onConfirmer,
}: {
  ouvert: boolean;
  onFermer: () => void;
  titre: string;
  resume: ReactNode;
  libelleConfirmer: string;
  motifRequis?: boolean;
  danger?: boolean;
  onConfirmer: (motif?: string) => Promise<unknown>;
}) {
  const [motif, setMotif] = useState('');
  const [motifTouche, setMotifTouche] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string>();

  const motifValide = motif.trim().length >= MOTIF_MIN;
  const fermer = () => {
    setMotif('');
    setMotifTouche(false);
    setErreur(undefined);
    onFermer();
  };

  const confirmer = async () => {
    if (motifRequis && !motifValide) {
      setMotifTouche(true);
      return;
    }
    setEnCours(true);
    setErreur(undefined);
    try {
      await onConfirmer(motifRequis ? motif.trim() : undefined);
      fermer();
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal opened={ouvert} onClose={fermer} title={titre} centered>
      <Stack>
        <Text>{resume}</Text>
        {motifRequis && (
          <Textarea
            label={t('confirmation.motif')}
            description={t('confirmation.motifAide')}
            required
            rows={3}
            value={motif}
            onChange={(e) => setMotif(e.currentTarget.value)}
            onBlur={() => setMotifTouche(true)}
            error={motifTouche && !motifValide ? t('confirmation.motifRequis') : undefined}
            data-autofocus
          />
        )}
        {erreur && (
          <Alert color="red" role="alert">
            {erreur}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={fermer}>
            {t('commun.annuler')}
          </Button>
          <Button color={danger ? 'red.9' : undefined} loading={enCours} onClick={() => void confirmer()}>
            {libelleConfirmer}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

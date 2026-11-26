import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { messageErreur as messageParDefaut } from './erreurs';

const MOTIF_MIN = 3;

/**
 * Boîte de confirmation des actions irréversibles (docs/08 §2, §7) : rappelle l'objet,
 * motif obligatoire si demandé, erreur de l'API affichée sans fermer la boîte.
 * Avec `saisieConfirmation`, une seconde étape exige de recopier une valeur (double confirmation).
 */
export function ConfirmationAction({
  ouvert,
  onFermer,
  titre,
  resume,
  libelleConfirmer,
  motifRequis = false,
  danger = false,
  saisieConfirmation,
  messageErreur = messageParDefaut,
  onConfirmer,
}: {
  ouvert: boolean;
  onFermer: () => void;
  titre: string;
  resume: ReactNode;
  libelleConfirmer: string;
  motifRequis?: boolean;
  danger?: boolean;
  saisieConfirmation?: { attendu: string; consigne: string; libelleConfirmer: string };
  messageErreur?: (erreur: unknown) => string;
  onConfirmer: (motif?: string) => Promise<unknown>;
}) {
  const [motif, setMotif] = useState('');
  const [motifTouche, setMotifTouche] = useState(false);
  const [etape, setEtape] = useState<1 | 2>(1);
  const [saisie, setSaisie] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string>();

  const motifValide = motif.trim().length >= MOTIF_MIN;
  const saisieValide = !saisieConfirmation || saisie.trim() === saisieConfirmation.attendu;
  const fermer = () => {
    setMotif('');
    setMotifTouche(false);
    setEtape(1);
    setSaisie('');
    setErreur(undefined);
    onFermer();
  };

  const confirmer = async () => {
    if (motifRequis && !motifValide) {
      setMotifTouche(true);
      return;
    }
    if (saisieConfirmation && etape === 1) {
      setEtape(2);
      return;
    }
    if (!saisieValide) return;
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
        {etape === 1 && motifRequis && (
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
        {etape === 2 && saisieConfirmation && (
          <TextInput
            label={saisieConfirmation.consigne}
            required
            autoComplete="off"
            value={saisie}
            onChange={(e) => setSaisie(e.currentTarget.value)}
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
          <Button
            color={danger ? 'red.9' : undefined}
            loading={enCours}
            disabled={etape === 2 && !saisieValide}
            onClick={() => void confirmer()}
          >
            {etape === 2 && saisieConfirmation ? saisieConfirmation.libelleConfirmer : libelleConfirmer}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

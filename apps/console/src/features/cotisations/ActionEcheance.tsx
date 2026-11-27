import { formatMontant } from '@assoflow/contracts';
import { Alert, Box, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { patchEcheancesId, postEcheancesIdExonerer } from '../../api/generated/cotisations/cotisations';
import type { Echeance } from '../../api/generated/modeles';
import { useAuMoinsUnePermission } from '../../auth/Si';
import { t } from '../../i18n';
import { ChampMontant } from '../../shared/ChampMontant';
import { ConfirmationAction } from '../../shared/ConfirmationAction';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatDate } from '../../shared/format';
import { Montant } from '../../shared/Montant';
import { BadgeStatut } from '../../shared/Statut';
import { invaliderCotisations } from './commun';

const COULEURS: Record<Echeance['situation'], { bg: string; fg: string }> = {
  payee: { bg: '#E6F4EA', fg: '#1B6B34' },
  partielle: { bg: '#FFF1E0', fg: '#8A4B00' },
  en_retard: { bg: '#FDE8E8', fg: '#A11B1B' },
  a_venir: { bg: '#EEF0F3', fg: '#4A5260' },
  exoneree: { bg: '#F3F0FF', fg: '#4B3B8F' },
};

/** Pastille d'une situation d'échéance (couleur + symbole, docs/08 §2). */
export function CouleursSituation({
  situation,
  children,
}: {
  situation: Echeance['situation'];
  children: ReactNode;
}) {
  const c = COULEURS[situation];
  return (
    <Box
      component="span"
      aria-hidden
      style={{
        display: 'inline-block',
        minWidth: 32,
        padding: '2px 6px',
        borderRadius: 6,
        background: c.bg,
        color: c.fg,
        fontWeight: 700,
        textAlign: 'center',
      }}
    >
      {children}
    </Box>
  );
}

/**
 * Détail d'une échéance (écran A9, clic sur une cellule) : ajustement du montant ou de la date (E4-04) et
 * exonération motivée (RG-COT-014), seulement sans imputation et pour une campagne active.
 */
export function ActionEcheance({
  echeance,
  campagneActive,
  onFermer,
}: {
  echeance?: Echeance;
  campagneActive: boolean;
  onFermer: () => void;
}) {
  const client = useQueryClient();
  const peutGerer = useAuMoinsUnePermission('cotisation.gerer');
  const peutExonerer = useAuMoinsUnePermission('cotisation.exonerer');
  const [montant, setMontant] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState(false);
  const [exoneration, setExoneration] = useState(false);
  const [vue, setVue] = useState<string>();

  // Réinitialise le formulaire quand une autre échéance est ouverte.
  if (echeance && vue !== echeance.id) {
    setVue(echeance.id);
    setMontant(echeance.montantDu);
    setDate(echeance.dateEcheance);
    setErreurs({});
    setErreur(undefined);
  }
  if (!echeance) return null;
  const modifiable = campagneActive && !echeance.imputee && echeance.situation !== 'exoneree';

  const fermer = () => {
    setVue(undefined);
    onFermer();
  };
  const ajuster = async () => {
    setEnCours(true);
    setErreur(undefined);
    try {
      await patchEcheancesId(echeance.id, {
        ...(montant !== null && montant !== echeance.montantDu ? { montantDu: montant } : {}),
        ...(date && date !== echeance.dateEcheance ? { dateEcheance: date } : {}),
      });
      await invaliderCotisations(client);
      fermer();
    } catch (e) {
      setErreurs(erreursDeChamps(e));
      setErreur(messageErreur(e));
    } finally {
      setEnCours(false);
    }
  };
  const inchange = montant === echeance.montantDu && date === echeance.dateEcheance;

  return (
    <>
      <Modal
        opened={!exoneration}
        onClose={fermer}
        title={t('echeances.detailTitre', { membre: echeance.membreNom, periode: echeance.libellePeriode })}
        centered
      >
        <Stack>
          <Group gap="sm">
            <BadgeStatut domaine="echeance" valeur={echeance.situation} />
            <Text size="sm">{t('echeances.dueLe', { date: formatDate(echeance.dateEcheance) })}</Text>
          </Group>
          <Group gap="lg">
            <Stack gap={0}>
              <Text size="sm" c="dimmed">
                {t('echeances.colDu')}
              </Text>
              <Montant valeur={echeance.montantDu} />
            </Stack>
            <Stack gap={0}>
              <Text size="sm" c="dimmed">
                {t('echeances.colPaye')}
              </Text>
              <Montant valeur={echeance.montantPaye} />
            </Stack>
          </Group>
          {echeance.motifExoneration && (
            <Text size="sm">{t('echeances.motifExoneration', { motif: echeance.motifExoneration })}</Text>
          )}
          {!modifiable && campagneActive && echeance.imputee && (
            <Alert color="gray">{t('echeances.nonModifiableImputee')}</Alert>
          )}
          {modifiable && peutGerer && (
            <Stack gap="sm">
              <ChampMontant
                label={t('echeances.nouveauMontant')}
                value={montant}
                onChange={setMontant}
                error={erreurs.montantDu}
              />
              <TextInput
                type="date"
                label={t('echeances.nouvelleDate')}
                value={date}
                onChange={(e) => setDate(e.currentTarget.value)}
                error={erreurs.dateEcheance}
              />
            </Stack>
          )}
          {erreur && (
            <Alert color="red" role="alert">
              {erreur}
            </Alert>
          )}
          <Group justify="flex-end">
            {modifiable && peutExonerer && (
              <Button variant="default" onClick={() => setExoneration(true)}>
                {t('echeances.exonerer')}
              </Button>
            )}
            {modifiable && peutGerer && (
              <Button onClick={() => void ajuster()} loading={enCours} disabled={inchange}>
                {t('echeances.ajuster')}
              </Button>
            )}
            {!(modifiable && (peutGerer || peutExonerer)) && (
              <Button variant="default" onClick={fermer}>
                {t('commun.fermer')}
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
      <ConfirmationAction
        ouvert={exoneration}
        onFermer={() => setExoneration(false)}
        titre={t('echeances.exonererTitre')}
        resume={t('echeances.exonererResume', {
          membre: echeance.membreNom,
          periode: echeance.libellePeriode,
          montant: formatMontant(echeance.montantDu),
        })}
        libelleConfirmer={t('echeances.exonerer')}
        motifRequis
        onConfirmer={async (motif) => {
          await postEcheancesIdExonerer(echeance.id, { motif: motif! });
          await invaliderCotisations(client);
          fermer();
        }}
      />
    </>
  );
}

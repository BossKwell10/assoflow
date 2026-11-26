import { Alert, Button, Stack } from '@mantine/core';
import { t } from '../i18n';
import { estConflitVersion } from './concurrence';
import { messageErreur } from './erreurs';

/** Erreur d'API affichée à l'utilisateur ; sur conflit de version (412), propose de recharger la fiche. */
export function AlerteErreur({ erreur, onRecharger }: { erreur: unknown; onRecharger?: () => void }) {
  if (!erreur) return null;
  return (
    <Alert color="red" role="alert">
      <Stack gap="xs" align="flex-start">
        {messageErreur(erreur)}
        {estConflitVersion(erreur) && onRecharger && (
          <Button size="xs" variant="white" color="red.9" onClick={onRecharger}>
            {t('commun.rechargerFiche')}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

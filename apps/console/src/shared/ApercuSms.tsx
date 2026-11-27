import { calculerSms } from '@assoflow/contracts';
import { Alert, Paper, Stack, Text } from '@mantine/core';
import { t } from '../i18n';

/**
 * Aperçu d'un SMS (docs/08 §7) : texte rendu, nombre de caractères, encodage et unités facturées
 * (GSM-7 160/153, Unicode 70/67, docs/06 §4.3), avec les caractères qui font passer le message en Unicode.
 */
export function ApercuSms({ texte }: { texte: string }) {
  const calcul = calculerSms(texte);
  return (
    <Stack gap={6} role="region" aria-label={t('apercuSms.titre')}>
      <Paper withBorder p="sm" bg="#F6F7F9" style={{ whiteSpace: 'pre-wrap' }}>
        <Text size="sm">{texte || '—'}</Text>
      </Paper>
      <Text size="sm">
        {t('apercuSms.compteur', {
          caracteres: calcul.longueur,
          unites: calcul.unites,
          encodage: calcul.encodage === 'gsm7' ? 'GSM-7' : 'Unicode',
        })}
      </Text>
      {calcul.horsGsm7.length > 0 && (
        <Alert color="orange" p="xs">
          <Text size="sm">{t('apercuSms.horsGsm7', { caracteres: calcul.horsGsm7.join(' ') })}</Text>
        </Alert>
      )}
    </Stack>
  );
}

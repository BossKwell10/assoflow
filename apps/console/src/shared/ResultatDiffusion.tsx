import { Alert, Text } from '@mantine/core';
import type { Diffusion } from '../api/generated/modeles';
import { t } from '../i18n';

/** Résultat d'un envoi groupé (relance, convocation) : messages mis en file, ignorés, quota. */
export function ResultatDiffusion({ diffusion }: { diffusion?: Diffusion }) {
  return (
    <div role="status" aria-live="polite">
      {diffusion && (
        <Alert color={diffusion.quotaRestant < diffusion.unitesEstimees ? 'orange' : 'green'}>
          <Text size="sm">{t('diffusion.notifications', { n: diffusion.notifications })}</Text>
          {diffusion.dejaEnvoyees > 0 && (
            <Text size="sm">{t('diffusion.dejaEnvoyees', { n: diffusion.dejaEnvoyees })}</Text>
          )}
          {diffusion.sansContact > 0 && (
            <Text size="sm">{t('diffusion.sansContact', { n: diffusion.sansContact })}</Text>
          )}
          <Text size="sm">
            {t('diffusion.quota', { unites: diffusion.unitesEstimees, restant: diffusion.quotaRestant })}
          </Text>
          {diffusion.quotaRestant < diffusion.unitesEstimees && (
            <Text size="sm" fw={600}>
              {t('diffusion.horsQuota')}
            </Text>
          )}
        </Alert>
      )}
    </div>
  );
}

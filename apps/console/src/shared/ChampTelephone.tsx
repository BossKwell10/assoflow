import { normaliserTelephone } from '@assoflow/contracts';
import { TextInput, type TextInputProps } from '@mantine/core';
import { t } from '../i18n';
import { formatTelephone } from './format';

/**
 * Lit une saisie de téléphone : `null` si vide, E.164 si valide (+225 par défaut, RG-MBR-007),
 * `undefined` si invalide.
 */
export function lireTelephone(saisie: string): string | null | undefined {
  if (!saisie.trim()) return null;
  try {
    return normaliserTelephone(saisie);
  } catch {
    return undefined;
  }
}

/** Saisie d'un téléphone avec préfixe +225 par défaut, normalisé et reformaté à la sortie du champ. */
export function ChampTelephone({
  value,
  onChange,
  ...props
}: Omit<TextInputProps, 'value' | 'onChange'> & { value: string; onChange: (saisie: string) => void }) {
  return (
    <TextInput
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      placeholder="07 01 02 03 04"
      description={t('champs.telephoneAide')}
      {...props}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      onBlur={(e) => {
        const e164 = lireTelephone(value);
        if (e164) onChange(formatTelephone(e164));
        props.onBlur?.(e);
      }}
    />
  );
}

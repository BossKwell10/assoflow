import { formatMontant, parseMontant } from '@assoflow/contracts';
import { Text, TextInput, type TextInputProps } from '@mantine/core';
import { useState } from 'react';
import { t } from '../i18n';

/**
 * Saisie d'un montant en FCFA : entier, séparateur de milliers à l'affichage, aucune décimale (D-007).
 * `onChange(null)` pour un champ vide ; une saisie invalide n'est pas transmise et affiche une erreur.
 */
export function ChampMontant({
  value,
  onChange,
  error,
  ...props
}: Omit<TextInputProps, 'value' | 'onChange'> & {
  value: number | null | undefined;
  onChange: (montant: number | null) => void;
}) {
  // Texte en cours d'édition ; `undefined` hors édition (affichage formaté de la valeur).
  const [texte, setTexte] = useState<string>();
  const [invalide, setInvalide] = useState(false);
  const affiche = texte ?? (value === null || value === undefined ? '' : formatMontant(value, false));

  return (
    <TextInput
      inputMode="numeric"
      {...props}
      value={affiche}
      error={invalide ? t('champs.montantInvalide') : error}
      rightSection={
        <Text size="sm" c="dimmed" aria-hidden>
          FCFA
        </Text>
      }
      rightSectionWidth={56}
      onFocus={(e) => {
        setTexte(value === null || value === undefined ? '' : String(value));
        props.onFocus?.(e);
      }}
      onChange={(e) => {
        const saisie = e.currentTarget.value;
        setTexte(saisie);
        if (!saisie.trim()) {
          setInvalide(false);
          onChange(null);
          return;
        }
        try {
          onChange(parseMontant(saisie));
          setInvalide(false);
        } catch {
          setInvalide(true);
        }
      }}
      onBlur={(e) => {
        if (!invalide) setTexte(undefined);
        props.onBlur?.(e);
      }}
    />
  );
}

import { formatMontant } from '@assoflow/contracts';
import { Text, type TextProps } from '@mantine/core';

/** Affiche un montant FCFA formaté ; rouge si négatif. */
export function Montant({ valeur, ...props }: { valeur: number } & TextProps) {
  return (
    <Text span fw={600} c={valeur < 0 ? '#A11B1B' : undefined} {...props}>
      {formatMontant(valeur)}
    </Text>
  );
}

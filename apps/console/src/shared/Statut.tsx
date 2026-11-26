import { definirStatut, type DomaineStatut, type TonStatut } from '@assoflow/contracts';
import { Badge } from '@mantine/core';

export type Ton = TonStatut;

const COULEURS: Record<Ton, { bg: string; fg: string }> = {
  succes: { bg: '#E6F4EA', fg: '#1B6B34' },
  attente: { bg: '#FFF1E0', fg: '#8A4B00' },
  alerte: { bg: '#FDE8E8', fg: '#A11B1B' },
  neutre: { bg: '#EEF0F3', fg: '#4A5260' },
};

/** Un statut est toujours un libellé ET une couleur (docs/08 §2). */
export function Statut({ ton, children }: { ton: Ton; children: string }) {
  const c = COULEURS[ton];
  return (
    <Badge
      radius="xl"
      variant="filled"
      styles={{ root: { background: c.bg, color: c.fg, textTransform: 'none' } }}
    >
      {children}
    </Badge>
  );
}

/** Statut piloté par le dictionnaire partagé (`STATUTS` de `@assoflow/contracts`, docs/08 §7). */
export function BadgeStatut({
  domaine,
  valeur,
}: {
  domaine: DomaineStatut;
  valeur: string | null | undefined;
}) {
  if (!valeur) return null;
  const { libelle, ton } = definirStatut(domaine, valeur);
  return <Statut ton={ton}>{libelle}</Statut>;
}

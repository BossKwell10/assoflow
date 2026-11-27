import { useState } from 'react';
import { useGetPaiements } from '../../api/generated/cotisations/cotisations';
import { t } from '../../i18n';
import { TableauPaiements, TAILLE_PAGE } from './commun';

/** Onglet « Paiements » de la fiche membre (A3) : paiements et annulations du membre, mêmes actions qu'en A11. */
export function PaiementsMembre({ membreId }: { membreId: string }) {
  const [curseurs, setCurseurs] = useState<string[]>([]);
  const liste = useGetPaiements({
    membreId,
    inclureAnnules: true,
    limite: TAILLE_PAGE,
    ...(curseurs.length ? { curseur: curseurs.at(-1) } : {}),
  });
  return (
    <TableauPaiements
      libelle={t('paiements.duMembre')}
      lignes={liste.data?.donnees}
      chargement={liste.isPending}
      erreur={liste.error}
      pagination={{
        aPrecedente: curseurs.length > 0,
        precedente: () => setCurseurs((c) => c.slice(0, -1)),
        curseurSuivant: liste.data?.page.curseurSuivant,
        suivante: (c) => setCurseurs((p) => [...p, c]),
      }}
    />
  );
}

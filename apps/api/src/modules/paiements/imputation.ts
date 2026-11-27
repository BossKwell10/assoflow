/** Échéance non soldée candidate à l'imputation d'un paiement. */
export interface EcheanceDue {
  id: string;
  membreId: string;
  /** Numéro du membre (`MBR-000123`) : départage des échéances d'une famille à date égale (RG-COT-021). */
  numeroMembre: string;
  campagneId: string;
  dateEcheance: string;
  numeroPeriode: number;
  /** Reste à payer (> 0). */
  reste: number;
}

export interface LigneImputation {
  echeanceId: string;
  membreId: string;
  montant: number;
}

/**
 * RG-COT-020 / RG-COT-021 : ventilation d'un paiement, calculée par le serveur.
 * 1. échéances non soldées de la campagne ciblée (si `campagneId`), par date croissante ;
 * 2. puis les échéances **échues** (date ≤ aujourd'hui) non soldées, par date croissante ;
 * 3. puis les échéances à venir, par date croissante ;
 * 4. le reste devient une avance (imputation sans échéance).
 * Pour une famille, l'ensemble des échéances des membres est trié par date puis par numéro de membre.
 */
export function ventiler(
  montant: number,
  dues: EcheanceDue[],
  options: { campagneId?: string | null; aujourdhui: string },
): { lignes: LigneImputation[]; avance: number } {
  const groupe = (e: EcheanceDue) =>
    options.campagneId && e.campagneId === options.campagneId
      ? 0
      : e.dateEcheance <= options.aujourdhui
        ? 1
        : 2;
  const triees = [...dues]
    .filter((e) => e.reste > 0)
    .sort(
      (a, b) =>
        groupe(a) - groupe(b) ||
        a.dateEcheance.localeCompare(b.dateEcheance) ||
        a.numeroMembre.localeCompare(b.numeroMembre) ||
        a.numeroPeriode - b.numeroPeriode ||
        a.id.localeCompare(b.id),
    );
  const lignes: LigneImputation[] = [];
  let reste = montant;
  for (const e of triees) {
    if (reste <= 0) break;
    const part = Math.min(reste, e.reste);
    lignes.push({ echeanceId: e.id, membreId: e.membreId, montant: part });
    reste -= part;
  }
  return { lignes, avance: reste };
}

import { lireBooleen, lireCurseurs, lireTexte, type RechercheTableau } from '../../shared/rechercheUrl';

/** Paramètres d'URL de `/cotisations/paiements` (filtres de `GET /paiements`, écran A11). */
export interface RecherchePaiements extends RechercheTableau {
  du?: string;
  au?: string;
  mode?: string;
  compteId?: string;
  campagneId?: string;
  inclureAnnules?: boolean;
}

export const validerRecherchePaiements = (s: Record<string, unknown>): RecherchePaiements => ({
  du: lireTexte(s.du),
  au: lireTexte(s.au),
  mode: lireTexte(s.mode),
  compteId: lireTexte(s.compteId),
  campagneId: lireTexte(s.campagneId),
  inclureAnnules: lireBooleen(s.inclureAnnules),
  curseurs: lireCurseurs(s.curseurs),
});

/** Paramètres d'URL de `/cotisations/paiements/saisie` : saisie pré-remplie depuis une fiche (A3, A5). */
export interface RechercheSaisie {
  membreId?: string;
  familleId?: string;
}

export const validerRechercheSaisie = (s: Record<string, unknown>): RechercheSaisie => ({
  membreId: lireTexte(s.membreId),
  familleId: lireTexte(s.familleId),
});

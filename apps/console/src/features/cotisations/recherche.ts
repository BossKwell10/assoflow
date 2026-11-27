import { lireCurseurs, lireTexte, type RechercheTableau } from '../../shared/rechercheUrl';

/** Paramètres d'URL de `/cotisations/campagnes` (filtres de `GET /campagnes`). */
export interface RechercheCampagnes extends RechercheTableau {
  exerciceId?: string;
  statut?: string;
  type?: string;
}

export const validerRechercheCampagnes = (s: Record<string, unknown>): RechercheCampagnes => ({
  exerciceId: lireTexte(s.exerciceId),
  statut: lireTexte(s.statut),
  type: lireTexte(s.type),
  curseurs: lireCurseurs(s.curseurs),
});

/** Paramètres d'URL de `/cotisations/echeances` (filtres de `GET /echeances`). */
export interface RechercheEcheances extends RechercheTableau {
  campagneId?: string;
  situation?: string;
  du?: string;
  au?: string;
  membreId?: string;
}

export const validerRechercheEcheances = (s: Record<string, unknown>): RechercheEcheances => ({
  campagneId: lireTexte(s.campagneId),
  situation: lireTexte(s.situation),
  du: lireTexte(s.du),
  au: lireTexte(s.au),
  membreId: lireTexte(s.membreId),
  curseurs: lireCurseurs(s.curseurs),
});

import { lireCurseurs, lireTexte, type RechercheTableau } from '../../shared/rechercheUrl';

/** Paramètres d'URL de `/communication` : onglet et filtres de l'historique (A22). */
export interface RechercheCommunication extends RechercheTableau {
  onglet?: string;
  statut?: string;
  modele?: string;
  membreId?: string;
}

export const validerRechercheCommunication = (s: Record<string, unknown>): RechercheCommunication => ({
  onglet: lireTexte(s.onglet),
  statut: lireTexte(s.statut),
  modele: lireTexte(s.modele),
  membreId: lireTexte(s.membreId),
  curseurs: lireCurseurs(s.curseurs),
});

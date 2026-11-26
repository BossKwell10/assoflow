import { lireBooleen, lireCurseurs, lireTexte, type RechercheTableau } from '../../shared/rechercheUrl';

/** Paramètres d'URL de `/membres` (lien partageable, retour arrière) — filtres de `GET /membres`. */
export interface RechercheMembres extends RechercheTableau {
  q?: string;
  statutAdhesion?: string;
  etat?: string;
  categorieId?: string;
  familleId?: string;
  diaspora?: boolean;
  enRetard?: boolean;
}

export const validerRechercheMembres = (s: Record<string, unknown>): RechercheMembres => ({
  q: lireTexte(s.q),
  statutAdhesion: lireTexte(s.statutAdhesion),
  etat: lireTexte(s.etat),
  categorieId: lireTexte(s.categorieId),
  familleId: lireTexte(s.familleId),
  diaspora: lireBooleen(s.diaspora),
  enRetard: lireBooleen(s.enRetard),
  tri: lireTexte(s.tri),
  curseurs: lireCurseurs(s.curseurs),
});

export interface RechercheFamilles extends RechercheTableau {
  q?: string;
}

export const validerRechercheFamilles = (s: Record<string, unknown>): RechercheFamilles => ({
  q: lireTexte(s.q),
  curseurs: lireCurseurs(s.curseurs),
});

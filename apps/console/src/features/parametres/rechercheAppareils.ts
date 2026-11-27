import { lireBooleen, lireCurseurs, lireTexte, type RechercheTableau } from '../../shared/rechercheUrl';

/** Paramètres d'URL de `/parametres/appareils` (A32) : appareil choisi pour les rejets, rejets acquittés. */
export interface RechercheAppareils extends RechercheTableau {
  appareilId?: string;
  inclureAcquittes?: boolean;
}

export const validerRechercheAppareils = (s: Record<string, unknown>): RechercheAppareils => ({
  appareilId: lireTexte(s.appareilId),
  inclureAcquittes: lireBooleen(s.inclureAcquittes),
  curseurs: lireCurseurs(s.curseurs),
});

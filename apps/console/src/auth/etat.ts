import { ecouterSession, lireClaim } from '../api/jeton';
import type { UtilisateurMoi } from '../api/generated/modeles';

export type MotifDeconnexion = 'inactivite' | 'expiree' | 'volontaire';

export interface EtatSession {
  /** `inconnu` tant que la reprise de session (refresh au chargement) n'a pas répondu. */
  statut: 'inconnu' | 'deconnecte' | 'connecte';
  utilisateur?: UtilisateurMoi;
  /** Association active : claim `aid` du jeton, ou choix explicite via `POST /auth/contexte`. */
  associationActiveId?: string;
  /** Pourquoi la dernière session s'est fermée (message sur /connexion). */
  motif?: MotifDeconnexion;
}

const INITIAL: EtatSession = { statut: 'inconnu' };
let etat: EtatSession = INITIAL;
let motifAttendu: MotifDeconnexion | undefined;
const abonnes = new Set<() => void>();

function changer(suivant: EtatSession) {
  etat = suivant;
  for (const a of abonnes) a();
}

export const lireEtatSession = () => etat;
export function abonnerEtatSession(abonne: () => void) {
  abonnes.add(abonne);
  return () => {
    abonnes.delete(abonne);
  };
}

/** Le prochain événement « perdue » portera ce motif (déconnexion volontaire ou inactivité). */
export const annoncerMotifDeconnexion = (motif: MotifDeconnexion) => {
  motifAttendu = motif;
};

export const marquerDeconnecte = () => changer({ statut: 'deconnecte', motif: etat.motif });

export const definirAssociationActive = (associationId: string) =>
  changer({ ...etat, associationActiveId: associationId });

ecouterSession((evenement) => {
  if (evenement.type === 'ouverte') {
    const { session } = evenement;
    changer({
      statut: 'connecte',
      utilisateur: session.utilisateur,
      associationActiveId: lireClaim(session.accessToken, 'aid'),
    });
  } else {
    const motif = motifAttendu ?? (etat.statut === 'connecte' ? 'expiree' : etat.motif);
    motifAttendu = undefined;
    changer({ statut: 'deconnecte', motif });
  }
});

/** Pour les tests : repart d'un état vierge. */
export function reinitialiserEtatSession() {
  motifAttendu = undefined;
  changer(INITIAL);
}

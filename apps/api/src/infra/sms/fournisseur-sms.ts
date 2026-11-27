/** Abstraction d'un fournisseur SMS (docs/06-jobs-notifications.md §4.1). */
export interface AccuseRemise {
  idFournisseur: string;
  statut: 'remise' | 'echec';
  remiseAt?: Date;
}

export interface MessageSms {
  /** Téléphone E.164. */
  to: string;
  texte: string;
  /** Référence interne (idempotence côté fournisseur, corrélation des accusés). */
  ref: string;
}

export interface ResultatEnvoiSms {
  idFournisseur: string;
  unites: number;
}

export interface FournisseurSms {
  code: string;
  /** Le fournisseur envoie des accusés de remise (sinon il est exclu du disjoncteur par taux de remise). */
  readonly accusesRemise: boolean;
  envoyer(msg: MessageSms): Promise<ResultatEnvoiSms>;
  /**
   * Webhook d'accusé de remise : `null` si la requête n'est pas authentique ou illisible.
   * `entetes` en minuscules (jeton ou signature propre au fournisseur).
   */
  traiterAccuse(payload: unknown, entetes: Record<string, string | undefined>): AccuseRemise | null;
  prendEnCharge(telephone: string): boolean;
}

/**
 * Erreur d'envoi. `transitoire` (erreur réseau, délai dépassé, 429 ou 5xx) : bascule sur le fournisseur suivant et
 * nouvel essai plus tard ; sinon (numéro refusé, 4xx) échec définitif chez ce fournisseur.
 */
export class ErreurFournisseurSms extends Error {
  constructor(
    readonly fournisseur: string,
    message: string,
    readonly transitoire: boolean,
  ) {
    super(message);
    this.name = 'ErreurFournisseurSms';
  }
}

/**
 * Point d'entrée de l'envoi (OTP, invitations, outbox) : le routeur `RouteurSms` (bascule, disjoncteur), qui
 * implémente aussi `FournisseurSms`.
 */
export const FOURNISSEUR_SMS = Symbol('FOURNISSEUR_SMS');

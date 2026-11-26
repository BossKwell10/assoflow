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
  /** Référence interne (idempotence, corrélation des accusés). */
  ref: string;
}

export interface FournisseurSms {
  code: string;
  envoyer(msg: MessageSms): Promise<{ idFournisseur: string; unites: number }>;
  traiterAccuse(payload: unknown): AccuseRemise | null;
  prendEnCharge(telephone: string): boolean;
}

export const FOURNISSEUR_SMS = Symbol('FOURNISSEUR_SMS');

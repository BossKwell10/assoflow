import { Logger } from '@nestjs/common';
import { masquerTelephone } from '@assoflow/contracts';
import { randomUUID } from 'node:crypto';
import type { FournisseurSms, MessageSms } from './fournisseur-sms.js';

/** Masque toute suite de 4 chiffres ou plus (codes OTP, numéros) dans un texte destiné aux logs. */
export function masquerTexte(texte: string): string {
  return texte.replace(/\d{4,}/g, (s) => '•'.repeat(s.length));
}

/**
 * Fournisseur « journal » (développement, test) : n'envoie rien, écrit le message masqué dans les logs.
 * En NODE_ENV=test uniquement, garde le dernier message par numéro en mémoire pour les tests.
 * Le vrai fournisseur et l'outbox arrivent au sprint 4 (E6-01, E6-02).
 */
export class JournalSms implements FournisseurSms {
  readonly code = 'journal';
  private readonly logger = new Logger('SMS');
  private readonly derniers = new Map<string, string>();

  constructor(private readonly modeTest: boolean) {}

  async envoyer(msg: MessageSms) {
    this.logger.log(`SMS ${msg.ref} → ${masquerTelephone(msg.to)} : ${masquerTexte(msg.texte)}`);
    if (this.modeTest) this.derniers.set(msg.to, msg.texte);
    return { idFournisseur: randomUUID(), unites: Math.max(1, Math.ceil(msg.texte.length / 160)) };
  }

  traiterAccuse(): null {
    return null;
  }

  prendEnCharge(): boolean {
    return true;
  }

  /** Dernier message envoyé à ce numéro (NODE_ENV=test uniquement). */
  dernierMessage(telephone: string): string | undefined {
    if (!this.modeTest) throw new Error('Disponible en NODE_ENV=test uniquement');
    return this.derniers.get(telephone);
  }

  /** Dernier code à 6 chiffres envoyé à ce numéro (NODE_ENV=test uniquement). */
  dernierCode(telephone: string): string | undefined {
    return this.dernierMessage(telephone)?.match(/\b(\d{6})\b/)?.[1];
  }
}

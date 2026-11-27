import { Logger } from '@nestjs/common';
import { masquerTelephone, unitesSms } from '@assoflow/contracts';
import { randomUUID } from 'node:crypto';
import type { FournisseurSms, MessageSms, ResultatEnvoiSms } from './fournisseur-sms.js';

/** Masque toute suite de 4 chiffres ou plus (codes OTP, numéros) dans un texte destiné aux logs. */
export function masquerTexte(texte: string): string {
  return texte.replace(/\d{4,}/g, (s) => '•'.repeat(s.length));
}

/**
 * Fournisseur « journal » (développement, test) : n'envoie rien, écrit le message masqué dans les logs.
 * En NODE_ENV=test uniquement, garde les messages par numéro en mémoire pour les tests.
 */
export class JournalSms implements FournisseurSms {
  readonly code: string = 'journal';
  readonly accusesRemise: boolean = false;
  protected readonly logger = new Logger('SMS');
  private readonly messages = new Map<string, string[]>();

  constructor(protected readonly modeTest: boolean) {}

  async envoyer(msg: MessageSms): Promise<ResultatEnvoiSms> {
    this.logger.log(`SMS ${msg.ref} → ${masquerTelephone(msg.to)} : ${masquerTexte(msg.texte)}`);
    this.memoriser(msg);
    return { idFournisseur: randomUUID(), unites: unitesSms(msg.texte) };
  }

  protected memoriser(msg: MessageSms): void {
    if (this.modeTest) this.messages.set(msg.to, [...(this.messages.get(msg.to) ?? []), msg.texte]);
  }

  traiterAccuse(
    _payload?: unknown,
    _entetes?: Record<string, string | undefined>,
  ): ReturnType<FournisseurSms['traiterAccuse']> {
    return null;
  }

  prendEnCharge(_telephone?: string): boolean {
    return true;
  }

  /** Messages envoyés à ce numéro, du plus ancien au plus récent (NODE_ENV=test uniquement). */
  messagesPour(telephone: string): string[] {
    if (!this.modeTest) throw new Error('Disponible en NODE_ENV=test uniquement');
    return this.messages.get(telephone) ?? [];
  }

  /** Dernier message envoyé à ce numéro (NODE_ENV=test uniquement). */
  dernierMessage(telephone: string): string | undefined {
    return this.messagesPour(telephone).at(-1);
  }

  /** Dernier code à 6 chiffres envoyé à ce numéro (NODE_ENV=test uniquement). */
  dernierCode(telephone: string): string | undefined {
    return this.dernierMessage(telephone)?.match(/\b(\d{6})\b/)?.[1];
  }
}

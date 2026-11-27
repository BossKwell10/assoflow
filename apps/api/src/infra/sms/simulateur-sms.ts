import { masquerTelephone, unitesSms } from '@assoflow/contracts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ErreurFournisseurSms, type AccuseRemise, type MessageSms } from './fournisseur-sms.js';
import { JournalSms, masquerTexte } from './journal-sms.js';

export type PanneSimulee = 'aucune' | 'transitoire' | 'definitive';

/**
 * Simulateur de fournisseur (recette, démonstration, tests) : se comporte comme un agrégateur réel — identifiant
 * de message, unités facturées, accusés de remise par webhook (`POST /v1/webhooks/sms/<code>`, en-tête
 * `X-Webhook-Token`) — sans rien envoyer. Une panne peut être simulée (`SMS_SIMULATEUR_PANNE` ou `panne` en test)
 * pour vérifier la bascule et les reprises (docs/06 §4.1).
 */
export class SimulateurSms extends JournalSms {
  override readonly accusesRemise = true;
  panne: PanneSimulee;
  /** Messages acceptés : identifiant du fournisseur → destinataire (accusés simulés). */
  readonly envoyes = new Map<string, { to: string; ref: string }>();

  constructor(
    override readonly code: string,
    modeTest: boolean,
    private readonly secretWebhook: string | undefined,
    panne: PanneSimulee = 'aucune',
  ) {
    super(modeTest);
    this.panne = panne;
  }

  override async envoyer(msg: MessageSms) {
    if (this.panne === 'transitoire') {
      throw new ErreurFournisseurSms(this.code, 'Service indisponible (503, panne simulée)', true);
    }
    if (this.panne === 'definitive') {
      throw new ErreurFournisseurSms(this.code, 'Numéro refusé (400, panne simulée)', false);
    }
    const idFournisseur = `${this.code}-${randomUUID()}`;
    this.logger.log(
      `SMS ${msg.ref} via ${this.code} (${idFournisseur}) → ${masquerTelephone(msg.to)} : ${masquerTexte(msg.texte)}`,
    );
    this.memoriser(msg);
    this.envoyes.set(idFournisseur, { to: msg.to, ref: msg.ref });
    return { idFournisseur, unites: unitesSms(msg.texte) };
  }

  /** Corps attendu : `{ "id": "<identifiant>", "statut": "remise" | "echec", "date": "<ISO 8601>" }`. */
  override traiterAccuse(payload: unknown, entetes: Record<string, string | undefined>): AccuseRemise | null {
    if (!this.secretWebhook || !jetonValide(entetes['x-webhook-token'], this.secretWebhook)) return null;
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;
    if (typeof p.id !== 'string' || (p.statut !== 'remise' && p.statut !== 'echec')) return null;
    const date = typeof p.date === 'string' ? new Date(p.date) : undefined;
    return {
      idFournisseur: p.id,
      statut: p.statut,
      remiseAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
    };
  }
}

/** Comparaison en temps constant d'un jeton de webhook. */
export function jetonValide(recu: string | undefined, attendu: string): boolean {
  if (!recu) return false;
  const a = Buffer.from(recu);
  const b = Buffer.from(attendu);
  return a.length === b.length && timingSafeEqual(a, b);
}

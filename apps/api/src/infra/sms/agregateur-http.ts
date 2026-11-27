import { unitesSms } from '@assoflow/contracts';
import {
  ErreurFournisseurSms,
  type AccuseRemise,
  type FournisseurSms,
  type MessageSms,
  type ResultatEnvoiSms,
} from './fournisseur-sms.js';
import { jetonValide } from './simulateur-sms.js';

export interface ConfigAgregateur {
  /** `agregateur_a` ou `agregateur_b` (docs/01 §6, `SMS_PROVIDERS`). */
  code: string;
  /** Point d'envoi HTTPS du fournisseur. */
  url: string;
  jeton: string;
  /** Identifiant d'expéditeur (sender ID) déclaré chez le fournisseur. */
  expediteur: string;
  /** Secret partagé des webhooks d'accusé de remise. */
  secretWebhook?: string;
  /** Préfixes E.164 servis (vide = tous), pour le routage par préfixe (docs/06 §4.1). */
  prefixes?: string[];
  delaiMs?: number;
}

/** Statuts d'accusé de remise usuels des agrégateurs, ramenés à `remise` / `echec` (les autres sont ignorés). */
const STATUTS_REMIS = new Set(['delivered', 'delivrd', 'remis', 'success']);
const STATUTS_ECHEC = new Set(['failed', 'undelivered', 'undeliv', 'rejected', 'expired', 'echec']);

/**
 * Adaptateur HTTP d'un agrégateur SMS (deux instances : `agregateur_a`, `agregateur_b`). Les clés et le contrat
 * exact de chaque fournisseur seront fournis au moment du contrat commercial : le format retenu ici est le format
 * REST le plus courant (JSON + jeton Bearer) et doit être aligné sur la documentation du fournisseur choisi.
 *
 * - Envoi : `POST <url>` `{ to, from, text, reference }` → `2xx { messageId, segments? }`.
 * - Erreurs : réseau, délai dépassé, 429 et 5xx → transitoires (bascule + nouvel essai) ; autres 4xx → définitives.
 * - Accusé : `POST /v1/webhooks/sms/<code>` avec `X-Webhook-Token`, corps `{ messageId, status, doneAt? }`.
 */
export class AgregateurHttpSms implements FournisseurSms {
  readonly accusesRemise = true;

  constructor(
    private readonly config: ConfigAgregateur,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get code(): string {
    return this.config.code;
  }

  async envoyer(msg: MessageSms): Promise<ResultatEnvoiSms> {
    let reponse: Response;
    try {
      reponse = await this.fetchFn(this.config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.jeton}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          to: msg.to,
          from: this.config.expediteur,
          text: msg.texte,
          reference: msg.ref,
        }),
        signal: AbortSignal.timeout(this.config.delaiMs ?? 8000),
      });
    } catch (e) {
      throw new ErreurFournisseurSms(this.code, `Fournisseur injoignable : ${(e as Error).message}`, true);
    }
    if (!reponse.ok) {
      const transitoire = reponse.status === 429 || reponse.status >= 500;
      throw new ErreurFournisseurSms(this.code, `Envoi refusé (HTTP ${reponse.status})`, transitoire);
    }
    const corps = (await reponse.json().catch(() => null)) as {
      messageId?: unknown;
      id?: unknown;
      segments?: unknown;
    } | null;
    const id = corps?.messageId ?? corps?.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new ErreurFournisseurSms(this.code, 'Réponse du fournisseur sans identifiant de message', true);
    }
    const segments = Number(corps?.segments);
    return {
      idFournisseur: String(id),
      unites: Number.isInteger(segments) && segments > 0 ? segments : unitesSms(msg.texte),
    };
  }

  traiterAccuse(payload: unknown, entetes: Record<string, string | undefined>): AccuseRemise | null {
    const secret = this.config.secretWebhook;
    if (!secret || !jetonValide(entetes['x-webhook-token'], secret)) return null;
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const id = p.messageId ?? p.id;
    const statut = typeof p.status === 'string' ? p.status.toLowerCase() : '';
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const etat = STATUTS_REMIS.has(statut) ? 'remise' : STATUTS_ECHEC.has(statut) ? 'echec' : null;
    if (!etat) return null;
    const date = typeof p.doneAt === 'string' ? new Date(p.doneAt) : undefined;
    return {
      idFournisseur: String(id),
      statut: etat,
      remiseAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
    };
  }

  prendEnCharge(telephone: string): boolean {
    const prefixes = this.config.prefixes ?? [];
    return prefixes.length === 0 || prefixes.some((p) => telephone.startsWith(p));
  }
}

import { Logger } from '@nestjs/common';
import {
  ErreurFournisseurSms,
  type AccuseRemise,
  type FournisseurSms,
  type MessageSms,
  type ResultatEnvoiSms,
} from './fournisseur-sms.js';

/** Statistiques de remise d'un fournisseur sur la dernière heure (tous tenants). */
export type StatistiquesRemise = (code: string) => Promise<{ envoyes: number; remis: number }>;

/** Disjoncteur (docs/06 §4.1) : taux de remise sur 1 h sous 90 %, mesuré sur au moins 20 messages. */
export const DISJONCTEUR = { tauxMinimal: 0.9, echantillonMinimal: 20, cacheMs: 60_000 } as const;

export interface ResultatRoute extends ResultatEnvoiSms {
  fournisseur: string;
}

/**
 * Routeur SMS : fournisseurs dans l'ordre de `SMS_PROVIDERS`. Bascule sur le suivant quand l'envoi échoue
 * (erreur réseau/5xx, ou refus propre au fournisseur), et place en dernier un fournisseur dont le disjoncteur est
 * ouvert (taux de remise insuffisant). Implémente `FournisseurSms` : OTP et invitations l'utilisent directement,
 * l'outbox des notifications via `router()`.
 */
export class RouteurSms implements FournisseurSms {
  readonly code = 'routeur';
  readonly accusesRemise = true;
  private readonly logger = new Logger('RouteurSms');
  private readonly disjoncteurs = new Map<string, { ouvert: boolean; jusqua: number }>();

  constructor(
    private fournisseurs: FournisseurSms[],
    private readonly statistiques?: StatistiquesRemise,
    private readonly modeTest = false,
  ) {
    if (fournisseurs.length === 0) throw new Error('Aucun fournisseur SMS configuré (SMS_PROVIDERS)');
  }

  /** Fournisseur par code (webhooks d'accusé de remise, tests). */
  fournisseur(code: string): FournisseurSms | undefined {
    return this.fournisseurs.find((f) => f.code === code);
  }

  get codes(): string[] {
    return this.fournisseurs.map((f) => f.code);
  }

  /** Remplace la liste des fournisseurs (NODE_ENV=test uniquement : scénarios de bascule). */
  utiliser(fournisseurs: FournisseurSms[]): void {
    if (!this.modeTest) throw new Error('Disponible en NODE_ENV=test uniquement');
    this.fournisseurs = fournisseurs;
    this.disjoncteurs.clear();
  }

  async envoyer(msg: MessageSms): Promise<ResultatEnvoiSms> {
    return this.router(msg);
  }

  /**
   * Envoie par le premier fournisseur disponible. Toutes les tentatives échouées → `ErreurFournisseurSms`
   * transitoire si au moins un échec l'était (nouvel essai plus tard), définitive sinon.
   */
  async router(msg: MessageSms): Promise<ResultatRoute> {
    const candidats = this.fournisseurs.filter((f) => f.prendEnCharge(msg.to));
    if (candidats.length === 0) {
      throw new ErreurFournisseurSms(this.code, 'Aucun fournisseur ne dessert ce numéro', false);
    }
    const etats = await Promise.all(candidats.map((f) => this.disjoncteurOuvert(f)));
    const ordre = [...candidats.filter((_, i) => !etats[i]), ...candidats.filter((_, i) => etats[i])];
    const erreurs: ErreurFournisseurSms[] = [];
    for (const f of ordre) {
      try {
        const r = await f.envoyer(msg);
        if (erreurs.length > 0) {
          this.logger.warn(
            `SMS ${msg.ref} envoyé par ${f.code} après échec de ${erreurs.map((e) => e.fournisseur)}`,
          );
        }
        return { ...r, fournisseur: f.code };
      } catch (e) {
        const erreur =
          e instanceof ErreurFournisseurSms
            ? e
            : new ErreurFournisseurSms(f.code, (e as Error).message, true);
        this.logger.warn(`Fournisseur ${f.code} en échec pour ${msg.ref} : ${erreur.message}`);
        erreurs.push(erreur);
      }
    }
    throw new ErreurFournisseurSms(
      this.code,
      erreurs.map((e) => `${e.fournisseur} : ${e.message}`).join(' ; '),
      erreurs.some((e) => e.transitoire),
    );
  }

  traiterAccuse(): AccuseRemise | null {
    return null;
  }

  prendEnCharge(telephone: string): boolean {
    return this.fournisseurs.some((f) => f.prendEnCharge(telephone));
  }

  private async disjoncteurOuvert(f: FournisseurSms): Promise<boolean> {
    if (!f.accusesRemise || !this.statistiques || this.fournisseurs.length < 2) return false;
    const cache = this.disjoncteurs.get(f.code);
    if (cache && cache.jusqua > Date.now()) return cache.ouvert;
    let ouvert = false;
    try {
      const s = await this.statistiques(f.code);
      ouvert = s.envoyes >= DISJONCTEUR.echantillonMinimal && s.remis / s.envoyes < DISJONCTEUR.tauxMinimal;
      if (ouvert && !cache?.ouvert) {
        this.logger.warn(
          `Disjoncteur ouvert pour ${f.code} : ${s.remis}/${s.envoyes} remis sur 1 h (< ${DISJONCTEUR.tauxMinimal * 100} %)`,
        );
      }
    } catch (e) {
      this.logger.error(`Taux de remise de ${f.code} illisible : ${(e as Error).message}`);
    }
    this.disjoncteurs.set(f.code, { ouvert, jusqua: Date.now() + DISJONCTEUR.cacheMs });
    return ouvert;
  }
}

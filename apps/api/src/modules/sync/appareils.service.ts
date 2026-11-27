import { Injectable } from '@nestjs/common';
import type { EnregistrementAppareil } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { introuvable, referenceInvalide } from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { JetonsService } from '../auth/jetons.service.js';

export interface LigneAppareil {
  id: string;
  user_id: string;
  utilisateur_nom: string;
  nom: string;
  plateforme: 'android' | 'ios' | 'web';
  version_app: string;
  prefixe_recu: string;
  derniere_sync: Date | null;
  dernier_curseur: string;
  empreinte_perimetre: string | null;
  elements_en_attente: number | null;
  rejets: number;
  revoque_at: Date | null;
  purge_demandee: boolean;
  created_at: Date;
}

const SELECT_APPAREIL = `
  SELECT a.id, a.user_id, trim(u.prenoms || ' ' || u.nom) AS utilisateur_nom, a.nom, a.plateforme, a.version_app,
         a.prefixe_recu, a.derniere_sync, a.dernier_curseur, a.empreinte_perimetre, a.elements_en_attente,
         (SELECT count(*)::int FROM rejets_sync r WHERE r.appareil_id = a.id AND r.acquitte_at IS NULL) AS rejets,
         a.revoque_at, a.purge_demandee, a.created_at
    FROM appareils a JOIN users u ON u.id = a.user_id`;

export function versDtoAppareil(l: LigneAppareil) {
  return {
    id: l.id,
    nom: l.nom,
    plateforme: l.plateforme,
    versionApp: l.version_app,
    prefixeRecu: l.prefixe_recu,
    utilisateur: { id: l.user_id, nom: l.utilisateur_nom },
    derniereSync: l.derniere_sync?.toISOString() ?? null,
    elementsEnAttente: l.elements_en_attente,
    rejetsNonAcquittes: l.rejets,
    revoqueAt: l.revoque_at?.toISOString() ?? null,
    purgeDemandee: l.purge_demandee,
    createdAt: l.created_at.toISOString(),
  };
}

/**
 * RG-NUM-003 : préfixe d'appareil = lettre + 2 chiffres, attribué dans l'ordre d'enregistrement (A01…A99, B00…),
 * unique dans l'association et jamais réattribué (les appareils ne sont jamais supprimés, seulement révoqués).
 */
export function prefixeDuRang(rang: number): string {
  const lettre = Math.floor(rang / 100);
  if (rang < 1 || lettre > 25) throw new Error(`Rang d'appareil hors limites : ${rang}`);
  return `${String.fromCharCode(65 + lettre)}${String(rang % 100).padStart(2, '0')}`;
}

/**
 * Appareils mobiles (E5-01, E5-06, RF-ADM-014, RF-SUP-033) : enregistrement confirmé par OTP (second facteur du
 * bureau sur mobile, docs/04 §1), préfixe de reçu, liste et révocation avec purge.
 */
@Injectable()
export class AppareilsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly jetons: JetonsService,
  ) {}

  async ligne(tx: Tx, id: string): Promise<LigneAppareil | undefined> {
    const r = await tx.query<LigneAppareil>(`${SELECT_APPAREIL} WHERE a.id = $1`, [id]);
    return r.rows[0];
  }

  /**
   * Appareil du jeton courant pour `/sync/*` : claim `dev` d'un appareil de l'association active appartenant à
   * l'utilisateur (la révocation est contrôlée par le guard, 401 `APPAREIL_REVOQUE`).
   */
  async courant(tx: Tx, auth: AuthRequete): Promise<LigneAppareil> {
    const a = auth.appareilId ? await this.ligne(tx, auth.appareilId) : undefined;
    if (!a || a.user_id !== auth.userId) {
      throw new ErreurMetier(
        'PERMISSION_REFUSEE',
        'Appareil non enregistré pour cette association : confirmez l’appareil (POST /auth/appareils)',
      );
    }
    if (a.revoque_at) throw new ErreurMetier('APPAREIL_REVOQUE', 'Cet appareil a été révoqué');
    return a;
  }

  /**
   * E5-01 : enregistre (ou rattache) l'appareil de la session mobile courante. Le jeton OTP (but
   * `confirmation_appareil`, même utilisateur) est à usage unique.
   */
  async enregistrer(auth: AuthRequete, p: EnregistrementAppareil) {
    if (auth.canal !== 'mobile' || !auth.associationId || !auth.sessionId) {
      throw new ErreurMetier(
        'PERMISSION_REFUSEE',
        'Enregistrement d’appareil réservé à une session mobile avec association active',
      );
    }
    const claims = await this.jetons.verifierJetonOtp(p.jetonOtp);
    if (claims.sub !== auth.userId || claims.but !== 'confirmation_appareil') {
      throw new ErreurMetier('OTP_INVALIDE', 'Ce code ne confirme pas un appareil pour ce compte');
    }
    const aid = auth.associationId;
    const sessionId = auth.sessionId;
    const { id, cree } = await this.db.tx(async (tx) => {
      const o = await tx.query(
        `UPDATE otp_codes SET jeton_utilise_at = now()
          WHERE id = $1 AND consomme_at IS NOT NULL AND jeton_utilise_at IS NULL`,
        [claims.jti],
      );
      if ((o.rowCount ?? 0) === 0) throw new ErreurMetier('OTP_INVALIDE', 'Jeton OTP déjà utilisé');

      let id: string;
      let cree: boolean;
      if (p.appareilId) {
        const existant = await this.ligne(tx, p.appareilId);
        if (!existant || existant.user_id !== auth.userId) {
          throw referenceInvalide('appareilId', 'Appareil introuvable pour ce compte');
        }
        if (existant.revoque_at) {
          throw new ErreurMetier('APPAREIL_REVOQUE', 'Cet appareil a été révoqué : enregistrez-le à nouveau');
        }
        await tx.query(`UPDATE appareils SET nom = $2, plateforme = $3, version_app = $4 WHERE id = $1`, [
          existant.id,
          p.nom,
          p.plateforme,
          p.versionApp,
        ]);
        id = existant.id;
        cree = false;
      } else {
        // Attribution séquentielle du préfixe, sérialisée par association.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`prefixe-appareil:${aid}`]);
        const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM appareils`);
        const r = await tx.query<{ id: string }>(
          `INSERT INTO appareils (user_id, association_id, nom, plateforme, version_app, prefixe_recu)
           VALUES ($1, app_association_id(), $2, $3, $4, $5) RETURNING id`,
          [auth.userId, p.nom, p.plateforme, p.versionApp, prefixeDuRang(n.rows[0]!.n + 1)],
        );
        id = r.rows[0]!.id;
        cree = true;
      }
      await tx.query(`UPDATE sessions SET appareil_id = $2 WHERE id = $1 AND user_id = $3`, [
        sessionId,
        id,
        auth.userId,
      ]);
      await this.audit.tracer(tx, {
        associationId: aid,
        action: cree ? 'appareil.enregistre' : 'appareil.rattache',
        entiteType: 'appareil',
        entiteId: id,
        apres: { nom: p.nom, plateforme: p.plateforme, versionApp: p.versionApp, sessionId },
      });
      return { id, cree };
    });
    const { jeton, expireDans } = await this.jetons.signerAcces({
      sub: auth.userId,
      sid: sessionId,
      aid,
      can: 'mobile',
      dev: id,
    });
    const appareil = await this.db.tx(async (tx) => versDtoAppareil((await this.ligne(tx, id))!));
    return { reponse: { appareil, accessToken: jeton, expireDans }, cree };
  }

  lister() {
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneAppareil>(
        `${SELECT_APPAREIL} ORDER BY a.revoque_at IS NOT NULL, a.derniere_sync DESC NULLS LAST, a.created_at DESC`,
      );
      return r.rows.map(versDtoAppareil);
    });
  }

  /** RF-ADM-014 : révocation immédiate (sessions de l'appareil révoquées) et purge des données locales. */
  revoquer(auth: AuthRequete, id: string, motif: string, purger: boolean) {
    return this.db.tx(async (tx) => {
      const a = await this.ligne(tx, id);
      if (!a) throw introuvable('Appareil introuvable');
      if (a.revoque_at) throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Cet appareil est déjà révoqué');
      await tx.query(
        `UPDATE appareils SET revoque_at = now(), revoque_par = $2, revoque_motif = $3, purge_demandee = $4
          WHERE id = $1`,
        [id, auth.userId, motif, purger],
      );
      const s = await tx.query(
        `UPDATE sessions SET revoque_at = now() WHERE appareil_id = $1 AND revoque_at IS NULL`,
        [id],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'appareil.revoque',
        entiteType: 'appareil',
        entiteId: id,
        avant: { prefixeRecu: a.prefixe_recu, utilisateur: a.user_id },
        apres: { motif, purger, sessionsRevoquees: s.rowCount ?? 0 },
      });
    });
  }
}

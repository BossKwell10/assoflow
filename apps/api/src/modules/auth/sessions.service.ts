import { Injectable } from '@nestjs/common';
import type { Canal } from '@assoflow/contracts';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { empreinteJeton, genererJetonOpaque } from './domain/hachage.js';

/** Durées des refresh tokens (docs/04 §3). */
export const DUREES_SESSION = {
  /** Console : inactivité 30 min (RF-006)… */
  inactiviteConsoleMs: 30 * 60_000,
  /** … et durée absolue 12 h. */
  absolueConsoleMs: 12 * 3_600_000,
  /** Mobile : glissante 30 jours. */
  mobileMs: 30 * 24 * 3_600_000,
} as const;

export interface NouvelleSession {
  sessionId: string;
  refreshToken: string;
  expireAt: Date;
}

interface LigneSession {
  id: string;
  user_id: string;
  famille_id: string;
  canal: Canal;
  association_id: string | null;
  appareil_id: string | null;
  expire_at: Date;
  revoque_at: Date | null;
  remplace_par: string | null;
  debut_famille: Date;
  user_statut: string;
}

export type ResultatRotation =
  | {
      statut: 'ok';
      session: NouvelleSession;
      userId: string;
      associationId: string | null;
      appareilId: string | null;
    }
  | { statut: 'reutilisation' | 'revoquee' | 'expiree' | 'inconnue' | 'canal' };

/**
 * Sessions = refresh tokens (table `sessions`, hors RLS, réservée au module auth).
 * Rotation à chaque usage ; la présentation d'un refresh déjà remplacé révoque toute la famille (E1-06).
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Calcule l'expiration d'un refresh token émis maintenant. */
  static expiration(canal: Canal, maintenant: Date, debutFamille: Date = maintenant): Date {
    if (canal === 'mobile') return new Date(maintenant.getTime() + DUREES_SESSION.mobileMs);
    return new Date(
      Math.min(
        maintenant.getTime() + DUREES_SESSION.inactiviteConsoleMs,
        debutFamille.getTime() + DUREES_SESSION.absolueConsoleMs,
      ),
    );
  }

  async creer(
    tx: Tx,
    p: { userId: string; canal: Canal; associationId: string | null; ip?: string; userAgent?: string },
  ): Promise<NouvelleSession> {
    const refreshToken = genererJetonOpaque();
    const expireAt = SessionsService.expiration(p.canal, new Date());
    const r = await tx.query<{ id: string }>(
      `INSERT INTO sessions (user_id, refresh_hash, famille_id, canal, ip, user_agent, expire_at, association_id)
       VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7) RETURNING id`,
      [
        p.userId,
        empreinteJeton(refreshToken),
        p.canal,
        p.ip ?? null,
        p.userAgent?.slice(0, 500) ?? null,
        expireAt,
        p.associationId,
      ],
    );
    return { sessionId: r.rows[0]!.id, refreshToken, expireAt };
  }

  /**
   * Rotation d'un refresh token. Toute anomalie est traitée dans la transaction (révocation de la famille
   * en cas de réutilisation, avec trace d'audit) puis renvoyée comme statut : l'appelant lève l'erreur
   * après le commit.
   */
  async tourner(
    tx: Tx,
    refreshToken: string,
    canalTransport: Canal,
    ip?: string,
    userAgent?: string,
  ): Promise<ResultatRotation> {
    const r = await tx.query<LigneSession>(
      `SELECT s.id, s.user_id, s.famille_id, s.canal, s.association_id, s.appareil_id, s.expire_at,
              s.revoque_at, s.remplace_par, u.statut AS user_statut,
              (SELECT min(f.created_at) FROM sessions f WHERE f.famille_id = s.famille_id) AS debut_famille
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_hash = $1
        FOR UPDATE OF s`,
      [empreinteJeton(refreshToken)],
    );
    const s = r.rows[0];
    if (!s) return { statut: 'inconnue' };
    if (s.canal !== canalTransport) return { statut: 'canal' };
    if (s.revoque_at) return { statut: 'revoquee' };
    if (s.remplace_par) {
      await this.revoquerFamille(tx, s.famille_id);
      await this.audit.tracer(tx, {
        associationId: null,
        acteurId: s.user_id,
        action: 'session.reutilisation_detectee',
        entiteType: 'session',
        entiteId: s.famille_id,
        apres: { canal: s.canal },
      });
      return { statut: 'reutilisation' };
    }
    const maintenant = new Date();
    if (s.expire_at <= maintenant || s.user_statut !== 'actif') {
      await this.revoquerFamille(tx, s.famille_id);
      return { statut: 'expiree' };
    }
    const nouveauJeton = genererJetonOpaque();
    const expireAt = SessionsService.expiration(s.canal, maintenant, s.debut_famille);
    const n = await tx.query<{ id: string }>(
      `INSERT INTO sessions (user_id, appareil_id, refresh_hash, famille_id, canal, ip, user_agent, expire_at, association_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        s.user_id,
        s.appareil_id,
        empreinteJeton(nouveauJeton),
        s.famille_id,
        s.canal,
        ip ?? null,
        userAgent?.slice(0, 500) ?? null,
        expireAt,
        s.association_id,
      ],
    );
    const nouvelleId = n.rows[0]!.id;
    await tx.query(`UPDATE sessions SET remplace_par = $2, dernier_usage = now() WHERE id = $1`, [
      s.id,
      nouvelleId,
    ]);
    return {
      statut: 'ok',
      session: { sessionId: nouvelleId, refreshToken: nouveauJeton, expireAt },
      userId: s.user_id,
      associationId: s.association_id,
      appareilId: s.appareil_id,
    };
  }

  async revoquerFamille(tx: Tx, familleId: string): Promise<void> {
    await tx.query(`UPDATE sessions SET revoque_at = now() WHERE famille_id = $1 AND revoque_at IS NULL`, [
      familleId,
    ]);
  }

  /** Déconnexion : révoque la famille de la session courante. */
  async revoquerParSession(tx: Tx, sessionId: string): Promise<string | null> {
    const r = await tx.query<{ refresh_hash: string }>(
      `UPDATE sessions SET revoque_at = now()
        WHERE famille_id = (SELECT famille_id FROM sessions WHERE id = $1) AND revoque_at IS NULL
        RETURNING refresh_hash`,
      [sessionId],
    );
    return r.rows[0]?.refresh_hash ?? null;
  }

  /** Révocation d'un accès (RF-ADM-014) : sessions de cet utilisateur dans ce tenant ; sans tenant : toutes. */
  async revoquerUtilisateur(tx: Tx, userId: string, associationId?: string): Promise<number> {
    const r = associationId
      ? await tx.query(
          `UPDATE sessions SET revoque_at = now()
            WHERE famille_id IN (SELECT famille_id FROM sessions WHERE user_id = $1 AND association_id = $2)
              AND revoque_at IS NULL`,
          [userId, associationId],
        )
      : await tx.query(`UPDATE sessions SET revoque_at = now() WHERE user_id = $1 AND revoque_at IS NULL`, [
          userId,
        ]);
    return r.rowCount ?? 0;
  }

  async definirAssociation(tx: Tx, sessionId: string, associationId: string): Promise<void> {
    await tx.query(`UPDATE sessions SET association_id = $2 WHERE id = $1`, [sessionId, associationId]);
  }

  /**
   * Vérifie, à chaque requête authentifiée, que la session du jeton n'est pas révoquée et que l'utilisateur
   * est actif (déconnexion, réutilisation de refresh, révocation d'accès → 401 SESSION_REVOQUEE).
   */
  async verifierActive(sessionId: string, userId: string): Promise<void> {
    const ok = await this.db.tx(async (tx) => {
      const r = await tx.query(
        `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2 AND s.revoque_at IS NULL AND u.statut = 'actif'`,
        [sessionId, userId],
      );
      return (r.rowCount ?? 0) > 0;
    });
    if (!ok) throw new ErreurMetier('SESSION_REVOQUEE', 'Session révoquée : reconnectez-vous');
  }
}

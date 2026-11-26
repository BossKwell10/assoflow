import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ErreurMetier } from '../common/erreur-metier.js';
import type { Tx } from './database.js';

/**
 * Idempotence des POST sensibles (`Idempotency-Key`, docs/07 §5) : même clé + même corps → même réponse ;
 * corps différent → 409 CONFLIT_IDEMPOTENCE. La réservation de la clé se fait dans la transaction métier
 * (une requête concurrente avec la même clé attend le commit puis rejoue la réponse).
 */
@Injectable()
export class IdempotenceService {
  async executer<T>(
    tx: Tx,
    p: { associationId: string; userId: string; cle: string | undefined; corps: unknown; statut: number },
    travail: () => Promise<T>,
  ): Promise<{ reponse: T; rejouee: boolean }> {
    if (!p.cle) return { reponse: await travail(), rejouee: false };
    if (p.cle.length > 100) {
      throw new ErreurMetier('VALIDATION', 'Idempotency-Key trop longue', [
        { champ: 'Idempotency-Key', code: 'TOO_BIG', message: '100 caractères maximum' },
      ]);
    }
    const empreinte = createHash('sha256')
      .update(JSON.stringify(p.corps ?? null))
      .digest('hex');
    const reserve = await tx.query(
      `INSERT INTO idempotence (association_id, cle, user_id, empreinte_requete, statut_http, reponse)
       VALUES ($1, $2, $3, $4, 0, 'null') ON CONFLICT DO NOTHING`,
      [p.associationId, p.cle, p.userId, empreinte],
    );
    if ((reserve.rowCount ?? 0) === 0) {
      const r = await tx.query<{
        user_id: string;
        empreinte_requete: string;
        statut_http: number;
        reponse: T;
      }>(
        `SELECT user_id, empreinte_requete, statut_http, reponse FROM idempotence WHERE association_id = $1 AND cle = $2`,
        [p.associationId, p.cle],
      );
      const ligne = r.rows[0];
      if (
        !ligne ||
        ligne.user_id !== p.userId ||
        ligne.empreinte_requete !== empreinte ||
        ligne.statut_http === 0
      ) {
        throw new ErreurMetier(
          'CONFLIT_IDEMPOTENCE',
          'Cette clé d’idempotence a déjà servi pour une autre requête',
        );
      }
      return { reponse: ligne.reponse, rejouee: true };
    }
    const reponse = await travail();
    await tx.query(
      `UPDATE idempotence SET statut_http = $3, reponse = $4 WHERE association_id = $1 AND cle = $2`,
      [p.associationId, p.cle, p.statut, JSON.stringify(reponse)],
    );
    return { reponse, rejouee: false };
  }
}

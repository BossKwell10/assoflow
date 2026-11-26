import { Injectable } from '@nestjs/common';
import { contexteCourant } from '../../common/contexte.js';
import type { Tx } from '../../infra/database.js';

export type TypeActeur = 'utilisateur' | 'systeme' | 'support' | 'impersonation';

export interface EntreeAudit {
  /** Tenant concerné ; `null` = chaîne plateforme (événements d'authentification hors tenant). */
  associationId: string | null;
  acteurId?: string | null;
  acteurType?: TypeActeur;
  /** `<entite>.<verbe_passe>` (docs/04 §7), ex. `acces.revoque`. */
  action: string;
  entiteType: string;
  entiteId?: string | null;
  avant?: Record<string, unknown> | null;
  apres?: Record<string, unknown> | null;
  ip?: string | null;
  appareilId?: string | null;
}

/**
 * Journal d'audit (RF-ADM-040 à 044, docs/02 §6). L'écriture se fait dans la transaction de l'opération
 * (`tx`) : si l'opération échoue, la trace disparaît avec elle ; si la trace échoue, l'opération échoue.
 * Le chaînage (hash) est calculé par le trigger `audit_chainage`. Jamais de secret dans `avant`/`apres`.
 */
@Injectable()
export class AuditService {
  async tracer(tx: Tx, entree: EntreeAudit): Promise<void> {
    const ctx = contexteCourant();
    await tx.query(
      `INSERT INTO audit_log (association_id, acteur_id, acteur_type, action, entite_type, entite_id,
                              avant, apres, ip, appareil_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entree.associationId,
        entree.acteurId === undefined ? (ctx?.userId ?? null) : entree.acteurId,
        entree.acteurType ?? 'utilisateur',
        entree.action,
        entree.entiteType,
        entree.entiteId ?? null,
        entree.avant ?? null,
        entree.apres ?? null,
        entree.ip ?? ctx?.ip ?? null,
        entree.appareilId ?? null,
        ctx?.requestId ?? null,
      ],
    );
  }
}

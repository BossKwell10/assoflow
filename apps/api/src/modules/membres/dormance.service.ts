import { Injectable } from '@nestjs/common';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * RG-MBR-005 [D] : passage automatique `actif → dormant` si le membre a au moins une échéance en retard et
 * aucun paiement depuis `jours_retard_dormant` jours (180 par défaut) ; retour `dormant → actif` au premier
 * paiement. `honoraire` et `bienfaiteur` ne changent que manuellement.
 *
 * Sprint 2 : fonctions de service seulement. Le job nocturne (BullMQ, docs/06) appellera `passerEnDormance()`
 * pour chaque association active ; le module paiements appellera `reactiverApresPaiement()` (sprint 4).
 */
@Injectable()
export class DormanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sans paiement imputé, la référence est la date d'adhésion : un nouveau membre en retard n'est pas
   * « dormant » avant `jours_retard_dormant` jours d'ancienneté. Les fiches désactivées et anonymisées sont ignorées.
   */
  passerEnDormance(associationId: string): Promise<{ membres: string[] }> {
    return this.db.tx(
      async (tx) => {
        const r = await tx.query<{ id: string; numero: string; dernier: string }>(
          `SELECT m.id, m.numero,
                  coalesce(greatest(
                    (SELECT max(p.date_paiement)::date FROM v_paiements_effectifs p WHERE p.membre_id = m.id),
                    (SELECT max(p.date_paiement)::date FROM imputations_paiement i
                       JOIN v_paiements_effectifs p ON p.id = i.paiement_id WHERE i.membre_id = m.id)
                  ), m.date_adhesion)::text AS dernier
             FROM membres m
             JOIN associations a ON a.id = m.association_id
            WHERE m.statut_adhesion = 'actif' AND m.etat <> 'desactive'
              AND m.deleted_at IS NULL AND m.anonymise_at IS NULL
              AND EXISTS (SELECT 1 FROM v_echeances_situation e
                           WHERE e.membre_id = m.id AND e.situation = 'en_retard')
              AND coalesce(greatest(
                    (SELECT max(p.date_paiement)::date FROM v_paiements_effectifs p WHERE p.membre_id = m.id),
                    (SELECT max(p.date_paiement)::date FROM imputations_paiement i
                       JOIN v_paiements_effectifs p ON p.id = i.paiement_id WHERE i.membre_id = m.id)
                  ), m.date_adhesion) < current_date - a.jours_retard_dormant
            ORDER BY m.numero
            FOR UPDATE OF m`,
        );
        for (const m of r.rows) {
          await tx.query(`UPDATE membres SET statut_adhesion = 'dormant' WHERE id = $1`, [m.id]);
          await this.audit.tracer(tx, {
            associationId,
            acteurId: null,
            acteurType: 'systeme',
            action: 'membre.passe_dormant',
            entiteType: 'membre',
            entiteId: m.id,
            avant: { statutAdhesion: 'actif' },
            apres: { statutAdhesion: 'dormant', dernierPaiementOuAdhesion: m.dernier, regle: 'RG-MBR-005' },
          });
        }
        return { membres: r.rows.map((m) => m.id) };
      },
      { requestId: `job-dormance-${associationId}`, associationId },
    );
  }

  /** RG-MBR-005 : retour automatique `dormant → actif` au premier paiement (dans la transaction du paiement). */
  async reactiverApresPaiement(tx: Tx, associationId: string, membreId: string): Promise<boolean> {
    const r = await tx.query(
      `UPDATE membres SET statut_adhesion = 'actif' WHERE id = $1 AND statut_adhesion = 'dormant' RETURNING id`,
      [membreId],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    await this.audit.tracer(tx, {
      associationId,
      acteurId: null,
      acteurType: 'systeme',
      action: 'membre.reactive_paiement',
      entiteType: 'membre',
      entiteId: membreId,
      avant: { statutAdhesion: 'dormant' },
      apres: { statutAdhesion: 'actif', regle: 'RG-MBR-005' },
    });
    return true;
  }
}

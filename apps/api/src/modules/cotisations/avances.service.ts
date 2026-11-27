import { Injectable } from '@nestjs/common';
import type { Tx } from '../../infra/database.js';

/**
 * Verrou transactionnel des imputations d'un membre : paiements, avances et annulations d'un même membre
 * sont sérialisés, pour que deux ventilations simultanées ne soldent pas deux fois la même échéance.
 */
export async function verrouillerImputationsMembre(tx: Tx, membreIds: string[]): Promise<void> {
  for (const id of [...new Set(membreIds)].sort()) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`imputation:${id}`]);
  }
}

/**
 * RG-COT-022 : les avances d'un membre (imputations sans échéance) sont imputées sur ses échéances non soldées
 * dès leur génération, par date d'échéance croissante. Chaque transfert = imputation négative sur l'avance et
 * positive sur l'échéance, avec le `paiement_id` de l'avance d'origine (tables en ajout seul, D-004).
 * Les avances les plus anciennes sont consommées d'abord.
 */
@Injectable()
export class AvancesService {
  async imputer(tx: Tx, membreIds: string[]): Promise<{ montant: number; imputations: number }> {
    if (membreIds.length === 0) return { montant: 0, imputations: 0 };
    const requete = (ids: string[]) =>
      tx.query<{ membre_id: string; paiement_id: string; dispo: string }>(
        `SELECT membre_id, paiement_id, sum(montant)::bigint AS dispo
           FROM imputations_paiement
          WHERE echeance_id IS NULL AND membre_id = ANY($1::uuid[])
            -- Avance d'un paiement annulé : déjà contre-passée par l'annulation (RG-COT-040).
            AND NOT EXISTS (SELECT 1 FROM paiements a WHERE a.annule_paiement_id = imputations_paiement.paiement_id)
          GROUP BY membre_id, paiement_id
         HAVING sum(montant) > 0
          ORDER BY membre_id, min(created_at), paiement_id`,
        [ids],
      );
    // Verrou des seuls membres ayant une avance (pas des milliers de verrous à l'activation), puis relecture.
    const candidats = [...new Set((await requete(membreIds)).rows.map((a) => a.membre_id))];
    if (candidats.length === 0) return { montant: 0, imputations: 0 };
    await verrouillerImputationsMembre(tx, candidats);
    const parMembre = new Map<string, { paiementId: string; dispo: number }[]>();
    for (const a of (await requete(candidats)).rows) {
      const liste = parMembre.get(a.membre_id) ?? [];
      liste.push({ paiementId: a.paiement_id, dispo: Number(a.dispo) });
      parMembre.set(a.membre_id, liste);
    }
    let total = 0;
    let imputations = 0;
    for (const [membreId, sources] of parMembre) {
      const dues = await tx.query<{ id: string; reste: string }>(
        `SELECT id, (montant_du - montant_paye)::bigint AS reste FROM v_echeances_situation
          WHERE membre_id = $1 AND situation IN ('a_venir', 'partielle', 'en_retard') AND montant_du > montant_paye
          ORDER BY date_echeance, numero_periode, id`,
        [membreId],
      );
      const lignes: [string, string | null, number][] = [];
      let i = 0;
      for (const e of dues.rows) {
        let reste = Number(e.reste);
        while (reste > 0 && i < sources.length) {
          const s = sources[i]!;
          const part = Math.min(reste, s.dispo);
          lignes.push([s.paiementId, null, -part], [s.paiementId, e.id, part]);
          s.dispo -= part;
          reste -= part;
          total += part;
          imputations++;
          if (s.dispo === 0) i++;
        }
        if (i >= sources.length) break;
      }
      if (lignes.length === 0) continue;
      await tx.query(
        `INSERT INTO imputations_paiement (association_id, paiement_id, echeance_id, membre_id, montant)
         SELECT app_association_id(), p, e, $1, m
           FROM unnest($2::uuid[], $3::uuid[], $4::bigint[]) AS t(p, e, m)`,
        [membreId, lignes.map((l) => l[0]), lignes.map((l) => l[1]), lignes.map((l) => l[2])],
      );
    }
    return { montant: total, imputations };
  }
}

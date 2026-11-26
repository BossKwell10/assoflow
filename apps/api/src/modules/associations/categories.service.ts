import { Injectable } from '@nestjs/common';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { codeSql, introuvable, invalide, VIOLATION_UNICITE } from '../../common/base-de-donnees.js';
import { DatabaseService } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';

/** Définition d'une table de catégories : colonnes exposées (nom d'API → colonne). */
interface DefinitionCategorie {
  table: 'categories_membres' | 'categories_depense';
  entite: 'categorie_membre' | 'categorie_depense';
  champs: Record<string, string>;
  /** Filtre des lignes visibles (suppression logique). */
  visibles: string;
}

const DEFINITIONS = {
  membre: {
    table: 'categories_membres',
    entite: 'categorie_membre',
    champs: { libelle: 'libelle', description: 'description', actif: 'actif' },
    visibles: 'deleted_at IS NULL',
  },
  depense: {
    table: 'categories_depense',
    entite: 'categorie_depense',
    champs: { nature: 'nature', libelle: 'libelle', actif: 'actif' },
    visibles: 'true',
  },
} satisfies Record<string, DefinitionCategorie>;

export type TypeCategorie = keyof typeof DEFINITIONS;

/** Catégories de membres et de dépenses (E2-05, RF-013, RF-ADM-021, RF-044). */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private select(d: DefinitionCategorie): string {
    return `SELECT id, ${Object.entries(d.champs)
      .map(([api, col]) => `${col} AS "${api}"`)
      .join(', ')} FROM ${d.table}`;
  }

  lister(type: TypeCategorie) {
    const d: DefinitionCategorie = DEFINITIONS[type];
    return this.db.tx(async (tx) => {
      const r = await tx.query<Record<string, unknown>>(
        `${this.select(d)} WHERE ${d.visibles} ORDER BY actif DESC, libelle`,
      );
      return r.rows;
    });
  }

  async creer(auth: AuthRequete, type: TypeCategorie, p: Record<string, unknown>) {
    const d: DefinitionCategorie = DEFINITIONS[type];
    const champs = Object.keys(d.champs).filter((c) => p[c] !== undefined);
    return this.avecUnicite(() =>
      this.db.tx(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO ${d.table} (association_id, ${champs.map((c) => d.champs[c]).join(', ')})
           VALUES (app_association_id(), ${champs.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          champs.map((c) => p[c]),
        );
        const id = r.rows[0]!.id;
        await this.audit.tracer(tx, {
          associationId: auth.associationId!,
          action: `${d.entite}.creee`,
          entiteType: d.entite,
          entiteId: id,
          apres: Object.fromEntries(champs.map((c) => [c, p[c]])),
        });
        return (await tx.query(`${this.select(d)} WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
      }),
    );
  }

  async modifier(auth: AuthRequete, type: TypeCategorie, id: string, p: Record<string, unknown>) {
    const d: DefinitionCategorie = DEFINITIONS[type];
    return this.avecUnicite(() =>
      this.db.tx(async (tx) => {
        const r = await tx.query<Record<string, unknown>>(
          `${this.select(d)} WHERE id = $1 AND ${d.visibles} FOR UPDATE`,
          [id],
        );
        const avant = r.rows[0];
        if (!avant) throw introuvable('Catégorie introuvable');
        const champs = Object.keys(d.champs).filter((c) => p[c] !== undefined && p[c] !== avant[c]);
        if (champs.length === 0) return avant;
        await tx.query(
          `UPDATE ${d.table} SET ${champs.map((c, i) => `${d.champs[c]} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...champs.map((c) => p[c])],
        );
        await this.audit.tracer(tx, {
          associationId: auth.associationId!,
          action: `${d.entite}.modifiee`,
          entiteType: d.entite,
          entiteId: id,
          avant: Object.fromEntries(champs.map((c) => [c, avant[c]])),
          apres: Object.fromEntries(champs.map((c) => [c, p[c]])),
        });
        return (await tx.query(`${this.select(d)} WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
      }),
    );
  }

  private async avecUnicite<T>(travail: () => Promise<T>): Promise<T> {
    try {
      return await travail();
    } catch (e) {
      if (codeSql(e) === VIOLATION_UNICITE) {
        throw invalide('libelle', 'DEJA_UTILISE', 'Une catégorie porte déjà ce libellé');
      }
      throw e;
    }
  }
}

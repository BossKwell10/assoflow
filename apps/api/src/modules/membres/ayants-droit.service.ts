import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import {
  codeSql,
  conflitIdempotence,
  empreinte,
  introuvable,
  VIOLATION_UNICITE,
} from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { MembresLecture } from './membres.lecture.js';

interface LigneAyantDroit {
  id: string;
  membre_id: string;
  nom: string;
  prenoms: string;
  lien: 'conjoint' | 'enfant' | 'parent' | 'autre';
  date_naissance: string | null;
  empreinte_creation: string | null;
  deleted_at: Date | null;
}

const versDto = (l: LigneAyantDroit) => ({
  id: l.id,
  nom: l.nom,
  prenoms: l.prenoms,
  lien: l.lien,
  dateNaissance: l.date_naissance,
});

const COLONNES = { nom: 'nom', prenoms: 'prenoms', lien: 'lien', dateNaissance: 'date_naissance' } as const;
type Champ = keyof typeof COLONNES;
type Saisie = Partial<Record<Champ, string | null>>;

/** Ayants droit d'un membre : conjoint, enfants… qui ne sont pas membres (E3-06, RF-028). */
@Injectable()
export class AyantsDroitService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly lecture: MembresLecture,
  ) {}

  lister(membreId: string) {
    return this.db.tx(async (tx) => {
      await this.lecture.ligne(tx, membreId);
      const r = await tx.query<LigneAyantDroit>(
        `SELECT * FROM ayants_droit WHERE membre_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
        [membreId],
      );
      return r.rows.map(versDto);
    });
  }

  async creer(auth: AuthRequete, membreId: string, p: Saisie & { id?: string }) {
    const id = p.id ?? uuidv7();
    const emp = empreinte({ ...p, id: undefined, membreId });
    return this.db.tx(async (tx) => {
      await this.membreModifiable(tx, membreId);
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`ayant_droit:${id}`]);
      const existant = await tx.query<LigneAyantDroit>(`SELECT * FROM ayants_droit WHERE id = $1`, [id]);
      if (existant.rows[0]) {
        if (existant.rows[0].empreinte_creation !== emp || existant.rows[0].deleted_at)
          throw conflitIdempotence();
        return { dto: versDto(existant.rows[0]), cree: false };
      }
      try {
        await tx.query(
          `INSERT INTO ayants_droit (id, association_id, membre_id, nom, prenoms, lien, date_naissance, empreinte_creation)
           VALUES ($1, app_association_id(), $2, $3, $4, $5, $6, $7)`,
          [id, membreId, p.nom, p.prenoms, p.lien, p.dateNaissance ?? null, emp],
        );
      } catch (e) {
        if (codeSql(e) === VIOLATION_UNICITE) throw conflitIdempotence();
        throw e;
      }
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'ayant_droit.cree',
        entiteType: 'ayant_droit',
        entiteId: id,
        apres: {
          membreId,
          nom: p.nom,
          prenoms: p.prenoms,
          lien: p.lien,
          dateNaissance: p.dateNaissance ?? null,
        },
      });
      return { dto: versDto((await this.ligne(tx, membreId, id))!), cree: true };
    });
  }

  modifier(auth: AuthRequete, membreId: string, id: string, p: Saisie) {
    return this.db.tx(async (tx) => {
      await this.membreModifiable(tx, membreId);
      const l = await this.ligne(tx, membreId, id, true);
      const avant: Record<string, unknown> = { membreId };
      const apres: Record<string, unknown> = { membreId };
      const champs = (Object.keys(COLONNES) as Champ[]).filter(
        (c) => p[c] !== undefined && p[c] !== l[COLONNES[c]],
      );
      if (champs.length === 0) return versDto(l);
      for (const c of champs) {
        avant[c] = l[COLONNES[c]];
        apres[c] = p[c];
      }
      await tx.query(
        `UPDATE ayants_droit SET ${champs.map((c, i) => `${COLONNES[c]} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...champs.map((c) => p[c])],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'ayant_droit.modifie',
        entiteType: 'ayant_droit',
        entiteId: id,
        avant,
        apres,
      });
      return versDto(await this.ligne(tx, membreId, id));
    });
  }

  /** Suppression logique (`deleted_at`, docs/02 §1). */
  supprimer(auth: AuthRequete, membreId: string, id: string) {
    return this.db.tx(async (tx) => {
      await this.membreModifiable(tx, membreId);
      await this.ligne(tx, membreId, id, true);
      await tx.query(`UPDATE ayants_droit SET deleted_at = now() WHERE id = $1`, [id]);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'ayant_droit.supprime',
        entiteType: 'ayant_droit',
        entiteId: id,
        apres: { membreId },
      });
    });
  }

  private async membreModifiable(tx: Tx, membreId: string): Promise<void> {
    const m = await this.lecture.ligne(tx, membreId);
    if (m.anonymise_at)
      throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Fiche anonymisée : plus aucune modification');
  }

  private async ligne(tx: Tx, membreId: string, id: string, verrouiller = false): Promise<LigneAyantDroit> {
    const r = await tx.query<LigneAyantDroit>(
      `SELECT * FROM ayants_droit WHERE id = $1 AND membre_id = $2 AND deleted_at IS NULL${verrouiller ? ' FOR UPDATE' : ''}`,
      [id, membreId],
    );
    if (!r.rows[0]) throw introuvable('Ayant droit introuvable');
    return r.rows[0];
  }
}

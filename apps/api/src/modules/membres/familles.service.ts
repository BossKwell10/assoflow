import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import {
  codeSql,
  conflitIdempotence,
  empreinte,
  introuvable,
  invalide,
  referenceInvalide,
  VIOLATION_UNICITE,
} from '../../common/base-de-donnees.js';
import { decoderCurseurTri, encoderCurseurTri } from '../../common/pagination.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { MembresLecture } from './membres.lecture.js';

interface LigneFamille {
  id: string;
  nom: string;
  chef_famille_id: string | null;
  village_origine: string | null;
  nombre_membres: number;
  empreinte_creation: string | null;
  cle_tri: string;
}

const SELECT_FAMILLE = `SELECT f.id, f.nom, f.chef_famille_id, f.village_origine, f.empreinte_creation,
       app_normaliser(f.nom) AS cle_tri,
       (SELECT count(*)::int FROM membres m
         WHERE m.famille_id = f.id AND m.deleted_at IS NULL AND m.etat <> 'desactive') AS nombre_membres
  FROM familles f`;

const versDto = (l: LigneFamille) => ({
  id: l.id,
  nom: l.nom,
  chefFamilleId: l.chef_famille_id,
  villageOrigine: l.village_origine,
  nombreMembres: l.nombre_membres,
});

/** Familles et chef de famille (E3-05, RF-021, RG-MBR-006). */
@Injectable()
export class FamillesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly lecture: MembresLecture,
  ) {}

  lister(f: { q?: string; limite: number; curseur?: string }) {
    const position = decoderCurseurTri(f.curseur, 'nom');
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneFamille>(
        `SELECT * FROM (${SELECT_FAMILLE} WHERE f.deleted_at IS NULL) x
          WHERE ($1::text IS NULL OR cle_tri LIKE '%' || app_normaliser($1) || '%')
            AND ($2::text IS NULL OR (cle_tri, id) > ($2::text, $3::uuid))
          ORDER BY cle_tri, id LIMIT $4`,
        [f.q?.trim() || null, position?.valeur ?? null, position?.id ?? null, f.limite + 1],
      );
      const lignes = r.rows.slice(0, f.limite);
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map(versDto),
        page: {
          curseurSuivant: derniere
            ? encoderCurseurTri({ tri: 'nom', valeur: derniere.cle_tri, id: derniere.id })
            : null,
          total: null,
        },
      };
    });
  }

  /**
   * Création avec id client facultatif (idempotence comme pour les membres). Le chef désigné est rattaché
   * à la famille (RG-MBR-006) ; il ne doit appartenir à aucune autre famille (un membre, une famille).
   */
  async creer(
    auth: AuthRequete,
    p: { id?: string; nom: string; chefFamilleId?: string | null; villageOrigine?: string | null },
  ): Promise<{ dto: ReturnType<typeof versDto>; cree: boolean }> {
    const id = p.id ?? uuidv7();
    const emp = empreinte({ ...p, id: undefined });
    return this.db.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`famille:${id}`]);
      const existant = await this.ligne(tx, id, false, true);
      if (existant) {
        if (existant.empreinte_creation !== emp) throw conflitIdempotence();
        return { dto: versDto(existant), cree: false };
      }
      let chefAttache = false;
      if (p.chefFamilleId) {
        const chef = await tx.query<{ famille_id: string | null; anonymise_at: Date | null }>(
          `SELECT famille_id, anonymise_at FROM membres WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [p.chefFamilleId],
        );
        const c = chef.rows[0];
        if (!c || c.anonymise_at) throw referenceInvalide('chefFamilleId', 'Membre introuvable');
        if (c.famille_id) {
          throw invalide(
            'chefFamilleId',
            'AUTRE_FAMILLE',
            'Ce membre appartient déjà à une autre famille (RG-MBR-006)',
          );
        }
        chefAttache = true;
      }
      try {
        await tx.query(
          `INSERT INTO familles (id, association_id, nom, chef_famille_id, village_origine, empreinte_creation)
           VALUES ($1, app_association_id(), $2, $3, $4, $5)`,
          [id, p.nom, p.chefFamilleId ?? null, p.villageOrigine ?? null, emp],
        );
      } catch (e) {
        if (codeSql(e) === VIOLATION_UNICITE) throw conflitIdempotence();
        throw e;
      }
      if (chefAttache) {
        await tx.query(`UPDATE membres SET famille_id = $2 WHERE id = $1`, [p.chefFamilleId, id]);
        await this.audit.tracer(tx, {
          associationId: auth.associationId!,
          action: 'membre.modifie',
          entiteType: 'membre',
          entiteId: p.chefFamilleId!,
          avant: { familleId: null },
          apres: { familleId: id },
        });
      }
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'famille.creee',
        entiteType: 'famille',
        entiteId: id,
        apres: {
          nom: p.nom,
          chefFamilleId: p.chefFamilleId ?? null,
          villageOrigine: p.villageOrigine ?? null,
        },
      });
      return { dto: versDto((await this.ligne(tx, id, false))!), cree: true };
    });
  }

  /** RG-MBR-006 : le chef doit être membre de la famille ; RG-MBR-002 : il reste le contact des membres sans téléphone. */
  modifier(
    auth: AuthRequete,
    id: string,
    p: { nom?: string; chefFamilleId?: string | null; villageOrigine?: string | null },
  ) {
    return this.db.tx(async (tx) => {
      const l = (await this.ligne(tx, id, true))!;
      const avant: Record<string, unknown> = {};
      const apres: Record<string, unknown> = {};
      const courant: Record<string, unknown> = {
        nom: l.nom,
        chefFamilleId: l.chef_famille_id,
        villageOrigine: l.village_origine,
      };
      for (const champ of ['nom', 'chefFamilleId', 'villageOrigine'] as const) {
        if (p[champ] !== undefined && p[champ] !== courant[champ]) {
          avant[champ] = courant[champ];
          apres[champ] = p[champ];
        }
      }
      if (Object.keys(apres).length === 0) return versDto(l);
      if ('chefFamilleId' in apres) {
        const chef = apres.chefFamilleId as string | null;
        if (chef) {
          const r = await tx.query(
            `SELECT 1 FROM membres WHERE id = $1 AND famille_id = $2 AND deleted_at IS NULL AND anonymise_at IS NULL`,
            [chef, id],
          );
          if ((r.rowCount ?? 0) === 0) {
            throw invalide(
              'chefFamilleId',
              'CHEF_HORS_FAMILLE',
              'Le chef de famille doit être membre de cette famille (RG-MBR-006)',
            );
          }
        }
        const sansTelephone = await tx.query(
          `SELECT 1 FROM membres WHERE famille_id = $1 AND telephone IS NULL AND deleted_at IS NULL
              AND id IS DISTINCT FROM $2::uuid LIMIT 1`,
          [id, chef],
        );
        if ((sansTelephone.rowCount ?? 0) > 0) {
          const telChef = chef
            ? await tx.query(`SELECT 1 FROM membres WHERE id = $1 AND telephone IS NOT NULL`, [chef])
            : null;
          if (!telChef || (telChef.rowCount ?? 0) === 0) {
            throw invalide(
              'chefFamilleId',
              'CONTACT_REQUIS',
              'Des membres sans téléphone dépendent du chef de famille : le nouveau chef doit avoir un téléphone (RG-MBR-002)',
            );
          }
        }
      }
      const colonnes: Record<string, string> = {
        nom: 'nom',
        chefFamilleId: 'chef_famille_id',
        villageOrigine: 'village_origine',
      };
      const champs = Object.keys(apres);
      await tx.query(
        `UPDATE familles SET ${champs.map((c, i) => `${colonnes[c]} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...champs.map((c) => apres[c])],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'famille.modifiee',
        entiteType: 'famille',
        entiteId: id,
        avant,
        apres,
      });
      return versDto((await this.ligne(tx, id, false))!);
    });
  }

  membresDe(id: string) {
    return this.db.tx(async (tx) => {
      await this.ligne(tx, id, false);
      const r = await tx.query<{ id: string }>(
        `SELECT id FROM membres WHERE famille_id = $1 AND deleted_at IS NULL ORDER BY nom, prenoms, id`,
        [id],
      );
      return Promise.all(r.rows.map((m) => this.lecture.dto(tx, m.id)));
    });
  }

  /** Famille relue sous RLS ; absente → 404 (sauf `facultatif`). */
  private async ligne(
    tx: Tx,
    id: string,
    verrouiller: boolean,
    facultatif = false,
  ): Promise<LigneFamille | null> {
    if (verrouiller) await tx.query(`SELECT 1 FROM familles WHERE id = $1 FOR UPDATE`, [id]);
    const r = await tx.query<LigneFamille>(`${SELECT_FAMILLE} WHERE f.id = $1 AND f.deleted_at IS NULL`, [
      id,
    ]);
    if (!r.rows[0] && !facultatif) throw introuvable('Famille introuvable');
    return r.rows[0] ?? null;
  }
}

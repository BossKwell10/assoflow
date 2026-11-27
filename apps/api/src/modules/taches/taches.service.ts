import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { introuvable } from '../../common/base-de-donnees.js';
import { contexteStorage, type ContexteRequete } from '../../common/contexte.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { FilesService } from '../../infra/files/files.js';
import { STOCKAGE_OBJETS, type StockageObjets } from '../../infra/stockage/stockage-objets.js';

export type StatutTache = 'en_attente' | 'en_cours' | 'terminee' | 'echec';

export interface LigneTache {
  id: string;
  association_id: string;
  type: string;
  parametres: Record<string, unknown>;
  statut: StatutTache;
  progression: number;
  resultat: Record<string, unknown> | null;
  erreur: string | null;
  demandee_par: string;
  created_at: Date;
  termine_at: Date | null;
}

export interface TacheDto {
  id: string;
  type: string;
  statut: StatutTache;
  progression: number;
  erreur: string | null;
  resultat: Record<string, unknown> | null;
  createdAt: string;
  termineAt: string | null;
}

/** Tâche en cours d'exécution, telle que la voit son gestionnaire. */
export interface TacheEnCours {
  id: string;
  type: string;
  associationId: string;
  userId: string;
  parametres: Record<string, unknown>;
  /** Avancement en pourcentage (écrit hors de la transaction métier, au plus une fois par palier de 5 %). */
  avancer(pourcentage: number): Promise<void>;
}

/** Résultat d'un gestionnaire ; les clés commençant par « _ » restent internes (jamais exposées). */
export type Gestionnaire = (t: TacheEnCours) => Promise<Record<string, unknown>>;

const COLONNES = `id, association_id, type, parametres, statut, progression, resultat, erreur, demandee_par,
                  created_at, termine_at`;

/** Clés internes retirées du résultat exposé. */
function resultatPublic(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
}

export function versDto(l: LigneTache): TacheDto {
  return {
    id: l.id,
    type: l.type,
    statut: l.statut,
    progression: l.progression,
    erreur: l.erreur,
    resultat: resultatPublic(l.resultat),
    createdAt: l.created_at.toISOString(),
    termineAt: l.termine_at?.toISOString() ?? null,
  };
}

/**
 * Tâches asynchrones (docs/06 §7) : `POST` → `202 Tache` → `GET /v1/taches/{id}` jusqu'à `terminee` ou `echec`.
 * Une ligne `taches` par demande (sous RLS) ; le job (file `rapports`) porte l'association et le demandeur, et
 * le gestionnaire s'exécute avec ce contexte (RLS, audit attribué au demandeur). Rejouable : une tâche déjà
 * terminée n'est pas réexécutée.
 */
@Injectable()
export class TachesService implements OnModuleInit {
  private readonly logger = new Logger('Taches');
  private readonly gestionnaires = new Map<string, Gestionnaire>();

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    @Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets,
  ) {}

  onModuleInit(): void {
    this.files.traiter('rapports', async (_nom, donnees) => {
      await this.executer(donnees as { tacheId: string; associationId: string; userId: string });
    });
  }

  enregistrer(type: string, gestionnaire: Gestionnaire): void {
    this.gestionnaires.set(type, gestionnaire);
  }

  /**
   * Crée la tâche puis la met en file après le commit. `preparer` s'exécute dans la même transaction, avant
   * l'insertion (contrôles et marquages qui doivent réussir ou échouer avec la création).
   */
  async creer(
    auth: AuthRequete,
    type: string,
    parametres: Record<string, unknown>,
    preparer?: (tx: Tx, id: string) => Promise<void>,
  ): Promise<TacheDto> {
    if (!this.gestionnaires.has(type)) throw new Error(`Type de tâche inconnu : ${type}`);
    const id = randomUUID();
    const ligne = await this.db.tx(async (tx) => {
      if (preparer) await preparer(tx, id);
      const r = await tx.query<LigneTache>(
        `INSERT INTO taches (id, association_id, type, parametres, demandee_par)
         VALUES ($1, app_association_id(), $2, $3, $4) RETURNING ${COLONNES}`,
        [id, type, parametres, auth.userId],
      );
      return r.rows[0]!;
    });
    await this.files.ajouter(
      'rapports',
      type,
      { tacheId: id, associationId: ligne.association_id, userId: auth.userId },
      id,
    );
    return versDto(ligne);
  }

  /**
   * Tâche du demandeur courant (une tâche d'un autre utilisateur est introuvable). Un fichier produit
   * (`resultat._cle`) est exposé par une URL de lecture de 5 min, recalculée à chaque appel (docs/06 §7).
   */
  async lire(auth: AuthRequete, id: string): Promise<TacheDto> {
    const ligne = await this.db.tx((tx) => this.ligne(tx, auth.userId, id));
    const dto = versDto(ligne);
    const cle = ligne.resultat?._cle;
    if (ligne.statut === 'terminee' && typeof cle === 'string' && dto.resultat) {
      dto.resultat = { ...dto.resultat, url: await this.stockage.urlLecture(cle) };
    }
    return dto;
  }

  /** Ligne brute (paramètres et résultat internes compris), pour les modules propriétaires du type. */
  async ligne(tx: Tx, userId: string, id: string, type?: string): Promise<LigneTache> {
    const r = await tx.query<LigneTache>(
      `SELECT ${COLONNES} FROM taches WHERE id = $1 AND demandee_par = $2 ${type ? 'AND type = $3' : ''}`,
      type ? [id, userId, type] : [id, userId],
    );
    if (!r.rows[0]) throw introuvable('Tâche introuvable');
    return r.rows[0];
  }

  /** Vingt dernières tâches du demandeur courant dans l'association active. */
  lister(auth: AuthRequete): Promise<TacheDto[]> {
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneTache>(
        `SELECT ${COLONNES} FROM taches WHERE demandee_par = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
        [auth.userId],
      );
      return r.rows.map(versDto);
    });
  }

  /** Exécute une tâche (appelé par la file `rapports`). */
  async executer(job: { tacheId: string; associationId: string; userId: string }): Promise<void> {
    const contexte: ContexteRequete = {
      requestId: `tache-${job.tacheId}`,
      associationId: job.associationId,
      userId: job.userId,
    };
    await contexteStorage.run(contexte, async () => {
      const ligne = await this.db.tx(async (tx) => {
        const r = await tx.query<LigneTache>(
          `UPDATE taches SET statut = 'en_cours' WHERE id = $1 AND statut IN ('en_attente', 'en_cours')
           RETURNING ${COLONNES}`,
          [job.tacheId],
        );
        return r.rows[0];
      });
      if (!ligne) return; // déjà terminée (rejeu) ou introuvable
      const gestionnaire = this.gestionnaires.get(ligne.type);
      let palier = 0;
      const tache: TacheEnCours = {
        id: ligne.id,
        type: ligne.type,
        associationId: ligne.association_id,
        userId: ligne.demandee_par,
        parametres: ligne.parametres,
        avancer: async (pct) => {
          const p = Math.max(0, Math.min(99, Math.floor(pct)));
          if (p < palier + 5) return;
          palier = p;
          await this.db.tx((tx) =>
            tx.query(`UPDATE taches SET progression = $2 WHERE id = $1`, [ligne.id, p]),
          );
        },
      };
      try {
        if (!gestionnaire) throw new Error(`Aucun gestionnaire pour ${ligne.type}`);
        const resultat = await gestionnaire(tache);
        await this.db.tx((tx) =>
          tx.query(
            `UPDATE taches SET statut = 'terminee', progression = 100, resultat = $2, erreur = NULL,
                    termine_at = now()
              WHERE id = $1`,
            [ligne.id, resultat],
          ),
        );
      } catch (e) {
        const metier = e instanceof ErreurMetier;
        if (!metier) this.logger.error(`Tâche ${ligne.type} ${ligne.id} en échec : ${(e as Error).stack}`);
        await this.db.tx((tx) =>
          tx.query(`UPDATE taches SET statut = 'echec', erreur = $2, termine_at = now() WHERE id = $1`, [
            ligne.id,
            metier ? e.detail : 'Erreur interne : la tâche n’a pas pu aboutir',
          ]),
        );
      }
    });
  }
}

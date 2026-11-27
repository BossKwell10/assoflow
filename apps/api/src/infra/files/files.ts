import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { CONFIG, type Config } from '../../config.js';

/**
 * Files BullMQ (docs/06 §2). Chaque file a un nom, une concurrence et une politique de reprise.
 * Les notifications (S4) s'ajouteront ici.
 */
export const DEFINITIONS_FILES = {
  rapports: { concurrence: 2, tentatives: 2, delaiMs: 60_000 },
  maintenance: { concurrence: 1, tentatives: 3, delaiMs: 5 * 60_000 },
} as const;
export type NomFile = keyof typeof DEFINITIONS_FILES;

export type Traitement = (nom: string, donnees: Record<string, unknown>) => Promise<void>;

/** Tâche planifiée (docs/06 §3) : expression cron en GMT, exécutée une seule fois par échéance. */
export interface Planification {
  nom: string;
  cron: string;
  executer: () => Promise<unknown>;
}

/**
 * Accès aux files. Deux modes (`TACHES_EXECUTION`, config) :
 * - `file` : les jobs vont dans Redis ; seul le processus `worker` les consomme et pose les planifications ;
 * - `processus` : pas de Redis, le job s'exécute dans le processus courant juste après la réponse
 *   (développement, tests). Aucune planification n'est posée dans ce mode.
 */
@Injectable()
export class FilesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Files');
  private readonly traitements = new Map<NomFile, Traitement>();
  private readonly planifications: Planification[] = [];
  private readonly queues = new Map<NomFile, Queue>();
  private readonly workers: Worker[] = [];
  private connexion?: Redis;
  private readonly enCours = new Set<Promise<void>>();

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  get mode(): 'file' | 'processus' {
    return this.config.TACHES_EXECUTION ?? 'processus';
  }

  /** Déclare le consommateur d'une file (appelé à l'initialisation des modules). */
  traiter(file: NomFile, traitement: Traitement): void {
    this.traitements.set(file, traitement);
  }

  /** Déclare une tâche planifiée de la file `maintenance`. */
  planifier(p: Planification): void {
    this.planifications.push(p);
  }

  /** Met un job en file. À appeler **après** le commit de la transaction qui l'a produit (docs/06 §1). */
  async ajouter(file: NomFile, nom: string, donnees: Record<string, unknown>, jobId?: string): Promise<void> {
    if (this.mode === 'processus') {
      const traitement = this.traitements.get(file);
      if (!traitement) throw new Error(`Aucun traitement pour la file ${file}`);
      const p = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => traitement(nom, donnees))
        .catch((e: unknown) => this.logger.error(`Job ${file}/${nom} en échec : ${(e as Error).message}`))
        .finally(() => this.enCours.delete(p));
      this.enCours.add(p);
      return;
    }
    const def = DEFINITIONS_FILES[file];
    await this.queue(file).add(nom, donnees, {
      jobId,
      attempts: def.tentatives,
      backoff: { type: 'exponential', delay: def.delaiMs },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  /** Exécute immédiatement une tâche planifiée (tests, exploitation). */
  async executerPlanification(nom: string): Promise<void> {
    const p = this.planifications.find((x) => x.nom === nom);
    if (!p) throw new Error(`Planification inconnue : ${nom}`);
    await p.executer();
  }

  /** Attend la fin des jobs exécutés dans le processus (tests, arrêt propre). */
  async vider(): Promise<void> {
    while (this.enCours.size > 0) await Promise.allSettled([...this.enCours]);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'file' || this.config.APP_ROLE !== 'worker') return;
    for (const [file, traitement] of this.traitements) {
      const worker = new Worker(
        file,
        async (job: Job<Record<string, unknown>>) => traitement(job.name, job.data),
        { connection: this.redis(), concurrency: DEFINITIONS_FILES[file].concurrence },
      );
      worker.on('failed', (job, e) => this.logger.error(`Job ${file}/${job?.name} en échec : ${e.message}`));
      this.workers.push(worker);
    }
    const maintenance = this.queue('maintenance');
    for (const p of this.planifications) {
      // Une seule planification par nom, quel que soit le nombre de workers (verrou porté par Redis).
      await maintenance.upsertJobScheduler(
        p.nom,
        { pattern: p.cron, tz: 'UTC' },
        { name: p.nom, opts: { attempts: DEFINITIONS_FILES.maintenance.tentatives } },
      );
    }
    if (this.planifications.length > 0 && !this.traitements.has('maintenance')) {
      this.workers.push(
        new Worker('maintenance', async (job: Job) => this.executerPlanification(job.name), {
          connection: this.redis(),
          concurrency: DEFINITIONS_FILES.maintenance.concurrence,
        }),
      );
    }
    this.logger.log(
      `Files consommées : ${[...this.traitements.keys(), 'maintenance'].join(', ')} ; ` +
        `planifications : ${this.planifications.map((p) => `${p.nom} (${p.cron})`).join(', ') || 'aucune'}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.vider();
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connexion?.disconnect();
  }

  private redis(): Redis {
    if (!this.config.REDIS_URL) throw new Error('REDIS_URL requis pour les files BullMQ');
    // BullMQ exige maxRetriesPerRequest = null pour les connexions bloquantes des workers.
    this.connexion ??= new Redis(this.config.REDIS_URL, { maxRetriesPerRequest: null });
    return this.connexion;
  }

  private queue(file: NomFile): Queue {
    let q = this.queues.get(file);
    if (!q) {
      q = new Queue(file, { connection: this.redis() });
      this.queues.set(file, q);
    }
    return q;
  }
}

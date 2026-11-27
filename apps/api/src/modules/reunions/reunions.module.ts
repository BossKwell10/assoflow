import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import {
  convocationSchema,
  reunionCreationSchema,
  type Convocation,
  type ReunionCreation,
} from '@assoflow/contracts';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { introuvable } from '../../common/base-de-donnees.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { decoderCurseur, encoderCurseur, lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { AuditService } from '../audit/audit.service.js';
import { DiffusionService, identiteAssociation } from '../notifications/diffusion.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { idPipe } from '../utilisateurs/acces.controller.js';

interface LigneReunion {
  id: string;
  ts: string;
  type: string;
  titre: string;
  debut: Date;
  lieu: string | null;
  ordre_du_jour: string | null;
  statut: string;
  pv_document_id: string | null;
  presents: number;
  convoques: number;
}

const SELECT_REUNION = `
  SELECT r.id, r.debut::text AS ts, r.type, r.titre, r.debut, r.lieu, r.ordre_du_jour, r.statut, r.pv_document_id,
         (SELECT count(*)::int FROM presences p
           WHERE p.reunion_id = r.id AND p.statut IN ('present', 'represente')) AS presents,
         (SELECT count(*)::int FROM notifications n
           WHERE n.origine_type = 'convocation' AND n.origine_id = r.id) AS convoques
    FROM reunions r`;

function versDto(l: LigneReunion) {
  return {
    id: l.id,
    type: l.type,
    titre: l.titre,
    debut: l.debut.toISOString(),
    lieu: l.lieu,
    ordreDuJour: l.ordre_du_jour,
    statut: l.statut,
    pvDocumentId: l.pv_document_id,
    presents: l.presents,
    convoques: l.convoques,
  };
}

/** `05/03/2027 a 10:00` (GMT) pour un SMS en GSM-7. */
function dateHeureSms(d: Date): string {
  const j = (n: number) => String(n).padStart(2, '0');
  return `${j(d.getUTCDate())}/${j(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} a ${j(d.getUTCHours())}:${j(d.getUTCMinutes())}`;
}

/**
 * Réunions minimales (E6-08, RF-063) : planification et convocation d'AG par SMS, sans le module réunion complet
 * (présences, PV et rapport moral en phase 2).
 */
@Injectable()
export class ReunionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly diffusion: DiffusionService,
    private readonly notifications: NotificationsService,
  ) {}

  lister(limite: number, curseur?: string) {
    const position = decoderCurseur(curseur);
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneReunion>(
        `${SELECT_REUNION} WHERE r.deleted_at IS NULL
            AND ($1::timestamptz IS NULL OR (r.debut, r.id) < ($1::timestamptz, $2::uuid))
          ORDER BY r.debut DESC, r.id DESC LIMIT $3`,
        [position?.ts ?? null, position?.id ?? null, limite + 1],
      );
      const lignes = r.rows.slice(0, limite);
      const derniere = r.rows.length > limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map(versDto),
        page: {
          curseurSuivant: derniere ? encoderCurseur({ ts: derniere.ts, id: derniere.id }) : null,
          total: null,
        },
      };
    });
  }

  private async ligne(tx: Tx, id: string): Promise<LigneReunion> {
    const r = await tx.query<LigneReunion>(`${SELECT_REUNION} WHERE r.id = $1 AND r.deleted_at IS NULL`, [
      id,
    ]);
    if (!r.rows[0]) throw introuvable('Réunion introuvable');
    return r.rows[0];
  }

  creer(auth: AuthRequete, p: ReunionCreation) {
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO reunions (association_id, type, titre, debut, lieu, ordre_du_jour)
         VALUES (app_association_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [p.type, p.titre, p.debut, p.lieu ?? null, p.ordreDuJour ?? null],
      );
      const id = r.rows[0]!.id;
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'reunion.creee',
        entiteType: 'reunion',
        entiteId: id,
        apres: { ...p },
      });
      return versDto(await this.ligne(tx, id));
    });
  }

  /**
   * RF-063 : une convocation SMS par membre ciblé (actif), dédoublonnée par réunion ; relais par le chef de
   * famille pour les membres sans téléphone (RF-060). Soumis au quota (priorité normale).
   */
  async convoquer(auth: AuthRequete, id: string, c: Convocation) {
    const { diffusion, creees } = await this.db.tx(async (tx) => {
      const reunion = await this.ligne(tx, id);
      if (reunion.statut !== 'planifiee' || reunion.debut.getTime() < Date.now()) {
        throw new ErreurMetier(
          'ETAT_INCOMPATIBLE',
          'Seule une réunion planifiée et à venir peut être convoquée',
        );
      }
      const params: unknown[] = [];
      let filtre = 'true';
      if (c.cible.categories?.length) {
        params.push(c.cible.categories);
        filtre = `m.categorie_id = ANY($1::uuid[])`;
      } else if (c.cible.membres?.length) {
        params.push(c.cible.membres);
        filtre = `m.id = ANY($1::uuid[])`;
      }
      const membres = await tx.query<{ id: string }>(
        `SELECT m.id FROM membres m
          WHERE m.etat = 'actif' AND m.deleted_at IS NULL AND m.anonymise_at IS NULL AND ${filtre}
          ORDER BY m.numero`,
        params,
      );
      const association = await identiteAssociation(tx);
      const resultat = await this.diffusion.preparer(
        tx,
        membres.rows.map((m) => ({
          membreId: m.id,
          code: 'convocation' as const,
          variables: {
            'association.sigle': association.sigle,
            'reunion.titre': reunion.titre,
            'reunion.date': dateHeureSms(reunion.debut),
            'reunion.lieu': reunion.lieu ?? 'lieu communique par le bureau',
          },
          cleDedup: `convocation:${id}:${m.id}`,
          origineType: 'convocation',
          origineId: id,
        })),
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'reunion.convoquee',
        entiteType: 'reunion',
        entiteId: id,
        apres: { cible: c.cible, ...resultat.diffusion },
      });
      return resultat;
    });
    await this.notifications.publier(creees);
    return diffusion;
  }
}

const pageSchema = z.object({ limite: z.string().optional(), curseur: z.string().optional() });

@Controller('reunions')
export class ReunionsController {
  constructor(private readonly reunions: ReunionsService) {}

  @Get()
  @Permission('association.lire')
  lister(@Query() query: unknown) {
    const f = valider(pageSchema, query);
    return this.reunions.lister(lireLimite(f.limite), f.curseur);
  }

  @Post()
  @Permission('reunion.gerer')
  creer(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.reunions.creer(auth, valider(reunionCreationSchema, corps));
  }

  @Post(':id/convoquer')
  @HttpCode(200)
  @Permission('reunion.gerer')
  convoquer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.reunions.convoquer(auth, id, valider(convocationSchema, corps));
  }
}

/** Réunions minimales et convocations par SMS (E6-08). */
@Module({
  imports: [NotificationsModule],
  controllers: [ReunionsController],
  providers: [ReunionsService],
})
export class ReunionsModule {}

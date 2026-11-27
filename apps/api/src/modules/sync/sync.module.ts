import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query, Res } from '@nestjs/common';
import {
  enregistrementAppareilSchema,
  pieceJointeSchema,
  revocationAppareilSchema,
  syncPullSchema,
  syncPushSchema,
} from '@assoflow/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { decoderCurseur, encoderCurseur, lireBooleen, lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { DatabaseService } from '../../infra/database.js';
import { AuthModule } from '../auth/auth.module.js';
import { MembresModule } from '../membres/membres.module.js';
import { PaiementsModule } from '../paiements/paiements.module.js';
import { idPipe } from '../utilisateurs/acces.controller.js';
import { AppareilsService } from './appareils.service.js';
import { PiecesJointesService } from './pieces-jointes.service.js';
import { PullService } from './pull.service.js';
import { PushService } from './push.service.js';

/** Rejets de synchronisation vus par la console (A32, RF-SUP-033). */
@Injectable()
export class RejetsService {
  constructor(private readonly db: DatabaseService) {}

  lister(f: { appareilId?: string; inclureAcquittes?: boolean; limite: number; curseur?: string }) {
    const position = decoderCurseur(f.curseur);
    return this.db.tx(async (tx) => {
      const r = await tx.query<{
        ts: string;
        id: string;
        table_cible: string;
        element_id: string;
        code: string;
        message: string;
        created_at: Date;
        appareil_id: string;
        appareil_nom: string;
        acquitte_at: Date | null;
      }>(
        `SELECT r.created_at::text AS ts, r.id, r.table_cible, r.element_id, r.code, r.message, r.created_at,
                r.appareil_id, a.nom || ' (' || a.prefixe_recu || ')' AS appareil_nom, r.acquitte_at
           FROM rejets_sync r JOIN appareils a ON a.id = r.appareil_id
          WHERE ($1::uuid IS NULL OR r.appareil_id = $1) AND ($2 OR r.acquitte_at IS NULL)
            AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
          ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
        [
          f.appareilId ?? null,
          f.inclureAcquittes ?? false,
          position?.ts ?? null,
          position?.id ?? null,
          f.limite + 1,
        ],
      );
      const lignes = r.rows.slice(0, f.limite);
      const derniere = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: lignes.map((x) => ({
          id: x.id,
          table: x.table_cible,
          elementId: x.element_id,
          code: x.code,
          message: x.message,
          createdAt: x.created_at.toISOString(),
          appareilId: x.appareil_id,
          appareilNom: x.appareil_nom,
          acquitteAt: x.acquitte_at?.toISOString() ?? null,
        })),
        page: {
          curseurSuivant: derniere ? encoderCurseur({ ts: derniere.ts, id: derniere.id }) : null,
          total: null,
        },
      };
    });
  }
}

/** E5-01 : enregistrement de l'appareil mobile (second facteur du bureau sur mobile). */
@Controller('auth/appareils')
export class EnregistrementAppareilController {
  constructor(private readonly appareils: AppareilsService) {}

  @Post()
  async enregistrer(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { reponse, cree } = await this.appareils.enregistrer(
      auth,
      valider(enregistrementAppareilSchema, corps),
    );
    void reply.status(cree ? 201 : 200);
    return reponse;
  }
}

const filtresRejets = z.object({
  appareilId: z.uuid().optional(),
  inclureAcquittes: z.string().optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

/** Synchronisation WatermelonDB (E5-02 à E5-04, docs/05). */
@Controller('sync')
export class SyncController {
  constructor(
    private readonly pull: PullService,
    private readonly push: PushService,
    private readonly rejets: RejetsService,
  ) {}

  @Post('pull')
  @HttpCode(200)
  tirer(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.pull.tirer(auth, valider(syncPullSchema, corps));
  }

  @Post('push')
  @HttpCode(200)
  pousser(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.push.pousser(auth, valider(syncPushSchema, corps));
  }

  @Get('rejets')
  @Permission('utilisateur.lire')
  listerRejets(@Query() query: unknown) {
    const f = valider(filtresRejets, query);
    return this.rejets.lister({
      appareilId: f.appareilId,
      inclureAcquittes: lireBooleen(f.inclureAcquittes, 'inclureAcquittes'),
      limite: lireLimite(f.limite),
      curseur: f.curseur,
    });
  }

  @Post('rejets/:id/acquitter')
  @HttpCode(204)
  async acquitter(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    await this.push.acquitter(auth, id);
  }
}

/** Appareils de l'association (A32, E5-06, RF-SUP-033, RF-ADM-014). */
@Controller('appareils')
export class AppareilsController {
  constructor(private readonly appareils: AppareilsService) {}

  @Get()
  @Permission('utilisateur.lire')
  lister() {
    return this.appareils.lister();
  }

  @Post(':id/revoquer')
  @HttpCode(204)
  @Permission('utilisateur.gerer')
  async revoquer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    const p = valider(revocationAppareilSchema, corps);
    await this.appareils.revoquer(auth, id, p.motif, p.purger ?? false);
  }
}

/** Pièces jointes par URL présignée (E5-05, RF-041, docs/05 §7). */
@Controller('pieces-jointes')
export class PiecesJointesController {
  constructor(private readonly pieces: PiecesJointesService) {}

  @Post()
  async declarer(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { dto, cree } = await this.pieces.declarer(auth, valider(pieceJointeSchema, corps));
    void reply.status(cree ? 201 : 200);
    return dto;
  }

  @Post(':id/url-upload')
  @HttpCode(200)
  urlUpload(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.pieces.urlUpload(auth, id);
  }

  @Post(':id/confirmer')
  @HttpCode(200)
  confirmer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.pieces.confirmer(auth, id);
  }

  @Get(':id/url-telechargement')
  urlTelechargement(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.pieces.urlTelechargement(auth, id);
  }
}

/** Synchronisation mobile, appareils, rejets et pièces jointes (E5). */
@Module({
  imports: [AuthModule, MembresModule, PaiementsModule],
  controllers: [
    EnregistrementAppareilController,
    SyncController,
    AppareilsController,
    PiecesJointesController,
  ],
  providers: [AppareilsService, PullService, PushService, PiecesJointesService, RejetsService],
})
export class SyncModule {}

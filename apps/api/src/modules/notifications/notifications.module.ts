import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CANAUX_NOTIFICATION,
  calculerSms,
  estCodeModele,
  MODELES_NOTIFICATION,
  modelePersonnaliseSchema,
  relanceSchema,
  STATUTS_NOTIFICATION,
  variablesInconnues,
  type CodeModele,
} from '@assoflow/contracts';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission, Public } from '../../common/auth/decorateurs.js';
import { introuvable, invalide } from '../../common/base-de-donnees.js';
import { lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { DatabaseService } from '../../infra/database.js';
import { FOURNISSEUR_SMS } from '../../infra/sms/fournisseur-sms.js';
import type { RouteurSms } from '../../infra/sms/routeur-sms.js';
import { AuditService } from '../audit/audit.service.js';
import { DiffusionService } from './diffusion.service.js';
import { NotificationsService } from './notifications.service.js';

/** Modèles personnalisables par une association (RF-ADM-023) : tous sauf les modèles plateforme (OTP, quota). */
const CODES_ASSOCIATION = (Object.keys(MODELES_NOTIFICATION) as CodeModele[]).filter(
  (c) => MODELES_NOTIFICATION[c].personnalisable,
);

/** Modèles de messages : globaux (docs/06 §5) et personnalisés par l'association (RF-SUP-042, RF-ADM-023). */
@Injectable()
export class ModelesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  lister() {
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ code: string; contenu: string; global: boolean }>(
        `SELECT code, contenu, association_id IS NULL AS global FROM modeles_notification
          WHERE canal = 'sms' AND langue = 'fr' AND actif`,
      );
      return CODES_ASSOCIATION.map((code) => this.dto(code, r.rows));
    });
  }

  private dto(code: CodeModele, lignes: { code: string; contenu: string; global: boolean }[]) {
    const def = MODELES_NOTIFICATION[code];
    const global = lignes.find((l) => l.code === code && l.global)?.contenu ?? def.contenu;
    const perso = lignes.find((l) => l.code === code && !l.global)?.contenu;
    const contenu = perso ?? global;
    return {
      code,
      canal: def.canal,
      langue: 'fr',
      libelle: def.libelle,
      contenu,
      contenuGlobal: global,
      variables: [...def.variables],
      personnalise: perso !== undefined,
      unites: calculerSms(contenu).unites,
    };
  }

  private verifierCode(code: string, canal: string): CodeModele {
    if (!estCodeModele(code) || canal !== 'sms' || !MODELES_NOTIFICATION[code].personnalisable) {
      throw introuvable('Modèle introuvable');
    }
    return code;
  }

  /** Seul le texte est personnalisable ; les variables restent celles du modèle global. */
  personnaliser(auth: AuthRequete, codeBrut: string, canal: string, contenu: string) {
    const code = this.verifierCode(codeBrut, canal);
    const inconnues = variablesInconnues(code, contenu);
    if (inconnues.length > 0) {
      throw invalide(
        'contenu',
        'VARIABLE_INCONNUE',
        `Variable(s) inconnue(s) pour ce modèle : ${inconnues.map((v) => `{{${v}}}`).join(', ')}`,
      );
    }
    return this.db.tx(async (tx) => {
      const avant = await tx.query<{ contenu: string }>(
        `SELECT contenu FROM modeles_notification
          WHERE association_id = app_association_id() AND code = $1 AND canal = 'sms' AND langue = 'fr'`,
        [code],
      );
      await tx.query(
        `INSERT INTO modeles_notification (association_id, code, canal, langue, contenu)
         VALUES (app_association_id(), $1, 'sms', 'fr', $2)
         ON CONFLICT (association_id, code, canal, langue)
         DO UPDATE SET contenu = EXCLUDED.contenu, actif = true, updated_at = now()`,
        [code, contenu],
      );
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'modele_notification.personnalise',
        entiteType: 'modele_notification',
        entiteId: `${code}/sms`,
        avant: avant.rows[0] ? { contenu: avant.rows[0].contenu } : null,
        apres: { contenu },
      });
      const r = await tx.query<{ code: string; contenu: string; global: boolean }>(
        `SELECT code, contenu, association_id IS NULL AS global FROM modeles_notification
          WHERE code = $1 AND canal = 'sms' AND langue = 'fr' AND actif`,
        [code],
      );
      return this.dto(code, r.rows);
    });
  }

  retablir(auth: AuthRequete, codeBrut: string, canal: string) {
    const code = this.verifierCode(codeBrut, canal);
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ contenu: string }>(
        `DELETE FROM modeles_notification
          WHERE association_id = app_association_id() AND code = $1 AND canal = 'sms' AND langue = 'fr'
         RETURNING contenu`,
        [code],
      );
      if (!r.rows[0]) throw introuvable('Ce modèle n’est pas personnalisé');
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'modele_notification.retabli',
        entiteType: 'modele_notification',
        entiteId: `${code}/sms`,
        avant: { contenu: r.rows[0].contenu },
      });
    });
  }
}

const filtresNotifications = z.object({
  membreId: z.uuid().optional(),
  statut: z.enum(STATUTS_NOTIFICATION).optional(),
  canal: z.enum(CANAUX_NOTIFICATION).optional(),
  modele: z.string().max(50).optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

/** Communication (A21, A22) : modèles, historique des envois, consommation SMS. */
@Controller()
export class CommunicationController {
  constructor(
    private readonly modeles: ModelesService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('modeles-notification')
  @Permission('communication.modeles')
  listerModeles() {
    return this.modeles.lister();
  }

  @Put('modeles-notification/:code/:canal')
  @Permission('communication.modeles')
  personnaliser(
    @Auth() auth: AuthRequete,
    @Param('code') code: string,
    @Param('canal') canal: string,
    @Body() corps: unknown,
  ) {
    return this.modeles.personnaliser(auth, code, canal, valider(modelePersonnaliseSchema, corps).contenu);
  }

  @Delete('modeles-notification/:code/:canal')
  @HttpCode(204)
  @Permission('communication.modeles')
  async retablir(@Auth() auth: AuthRequete, @Param('code') code: string, @Param('canal') canal: string) {
    await this.modeles.retablir(auth, code, canal);
  }

  @Get('notifications')
  @Permission('communication.annoncer')
  lister(@Query() query: unknown) {
    const f = valider(filtresNotifications, query);
    return this.notifications.lister({ ...f, limite: lireLimite(f.limite) });
  }

  @Get('sms/consommation')
  @Permission('association.lire')
  consommation() {
    return this.notifications.consommation();
  }
}

/** Relance manuelle des échéances en retard (écran A10). */
@Controller('echeances')
export class RelancesController {
  constructor(private readonly diffusion: DiffusionService) {}

  @Post('relancer')
  @HttpCode(200)
  @Permission('cotisation.gerer')
  relancer(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.diffusion.relancer(auth, valider(relanceSchema, corps).echeanceIds);
  }
}

/** Accusés de remise des fournisseurs (route publique, authentifiée par jeton propre au fournisseur). */
@Controller('webhooks/sms')
export class WebhooksSmsController {
  constructor(
    @Inject(FOURNISSEUR_SMS) private readonly sms: RouteurSms,
    private readonly notifications: NotificationsService,
  ) {}

  @Post(':fournisseur')
  @Public()
  @HttpCode(204)
  async accuser(
    @Param('fournisseur') code: string,
    @Body() corps: unknown,
    @Headers() entetes: Record<string, string | undefined>,
  ): Promise<void> {
    const accuse = this.sms.fournisseur(code)?.traiterAccuse(corps, entetes) ?? null;
    if (!accuse) throw introuvable('Webhook inconnu');
    await this.notifications.accuser(code, accuse.idFournisseur, accuse.statut, accuse.remiseAt);
  }
}

/** Notifications (E6) : outbox, envoi, rappels, relances, quotas, modèles, webhooks. */
@Module({
  controllers: [CommunicationController, RelancesController, WebhooksSmsController],
  providers: [NotificationsService, DiffusionService, ModelesService],
  exports: [NotificationsService, DiffusionService],
})
export class NotificationsModule {}

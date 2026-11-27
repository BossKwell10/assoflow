import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ayantDroitMajSchema,
  ayantDroitSchema,
  doublonDecisionSchema,
  ETATS_MEMBRE,
  familleMajSchema,
  familleSchema,
  importConfirmationSchema,
  membreCreationSchema,
  membreMajSchema,
  motifSchema,
  STATUTS_ADHESION,
} from '@assoflow/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { lireFichierMultipart, lireImageMultipart } from '../../common/images.js';
import { lireBooleen, lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { idPipe } from '../utilisateurs/acces.controller.js';
import { AyantsDroitService } from './ayants-droit.service.js';
import { CarteMembreService } from './carte.service.js';
import { ImportMembresService } from './import/import.service.js';
import { modeleImportXlsx } from './import/lecture-fichier.js';
import { FamillesService } from './familles.service.js';
import { MembresRequetes, TRIS_MEMBRES } from './membres.requetes.js';
import { MembresService } from './membres.service.js';

const filtresSchema = z.object({
  q: z.string().max(100).optional(),
  statutAdhesion: z.enum(STATUTS_ADHESION).optional(),
  etat: z.enum(ETATS_MEMBRE).optional(),
  categorieId: z.uuid().optional(),
  familleId: z.uuid().optional(),
  diaspora: z.string().optional(),
  enRetard: z.string().optional(),
  tri: z.enum(TRIS_MEMBRES).default('nom'),
  limite: z.string().optional(),
  curseur: z.string().optional(),
  total: z.string().optional(),
});

const pageSchema = z.object({
  q: z.string().max(100).optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

/** Membres (E3-01 à E3-04, E3-06 à E3-09, E3-11). */
@Controller('membres')
export class MembresController {
  constructor(
    private readonly membres: MembresService,
    private readonly requetes: MembresRequetes,
    private readonly ayantsDroit: AyantsDroitService,
    private readonly imports: ImportMembresService,
    private readonly cartes: CarteMembreService,
  ) {}

  @Get()
  @Permission('membre.lire')
  lister(@Query() query: unknown) {
    const f = valider(filtresSchema, query);
    return this.requetes.lister({
      ...f,
      diaspora: lireBooleen(f.diaspora, 'diaspora'),
      enRetard: lireBooleen(f.enRetard, 'enRetard'),
      total: lireBooleen(f.total, 'total'),
      limite: lireLimite(f.limite),
    });
  }

  /** 201 à la création, 200 au rejeu idempotent (même id, même contenu). */
  @Post()
  @Permission('membre.creer')
  async creer(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { dto, cree } = await this.membres.creer(auth, valider(membreCreationSchema, corps));
    void reply.status(cree ? 201 : 200);
    return dto;
  }

  /** RF-024 : modèle Excel de l'import (écran A6, étape 1). */
  @Get('import/modele')
  @Permission('membre.importer')
  async modeleImport(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="modele-import-membres.xlsx"');
    return modeleImportXlsx();
  }

  /** RF-024, RG-MBR-007 : structure vérifiée immédiatement (422), analyse ligne par ligne en tâche (202). */
  @Post('import')
  @HttpCode(202)
  @Permission('membre.importer')
  async importer(@Auth() auth: AuthRequete, @Req() req: FastifyRequest) {
    return this.imports.demanderAnalyse(auth, await lireFichierMultipart(req));
  }

  @Get('import/:tacheId')
  @Permission('membre.importer')
  rapportImport(@Auth() auth: AuthRequete, @Param('tacheId', idPipe) tacheId: string) {
    return this.imports.rapport(auth, tacheId);
  }

  @Post('import/:tacheId/confirmer')
  @HttpCode(202)
  @Permission('membre.importer')
  confirmerImport(
    @Auth() auth: AuthRequete,
    @Param('tacheId', idPipe) tacheId: string,
    @Body() corps: unknown,
  ) {
    const c = valider(importConfirmationSchema, corps);
    return this.imports.confirmer(auth, tacheId, c.inclureDoublons ?? false);
  }

  @Get('doublons')
  @Permission('membre.lire')
  doublons() {
    return this.membres.doublons();
  }

  @Post(':id/doublon')
  @HttpCode(200)
  @Permission('membre.modifier')
  doublon(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    valider(doublonDecisionSchema, corps);
    return this.membres.ecarterDoublon(auth, id);
  }

  @Get(':id')
  @Permission('membre.lire')
  lire(@Param('id', idPipe) id: string) {
    return this.membres.lire(id);
  }

  @Patch(':id')
  @Permission('membre.modifier')
  modifier(
    @Auth() auth: AuthRequete,
    @Param('id', idPipe) id: string,
    @Body() corps: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.membres.modifier(auth, id, valider(membreMajSchema, corps), ifMatch);
  }

  @Post(':id/suspendre')
  @HttpCode(200)
  @Permission('membre.suspendre')
  suspendre(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.membres.changerEtat(auth, id, 'suspendre', valider(motifSchema, corps).motif);
  }

  @Post(':id/reactiver')
  @HttpCode(200)
  @Permission('membre.suspendre')
  reactiver(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.membres.changerEtat(auth, id, 'reactiver');
  }

  @Post(':id/desactiver')
  @HttpCode(200)
  @Permission('membre.suspendre')
  desactiver(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.membres.changerEtat(auth, id, 'desactiver', valider(motifSchema, corps).motif);
  }

  @Post(':id/anonymiser')
  @HttpCode(200)
  @Permission('membre.anonymiser')
  anonymiser(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.membres.anonymiser(auth, id, valider(motifSchema, corps).motif);
  }

  @Post(':id/acces-app')
  @Permission('utilisateur.gerer')
  accesApp(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.membres.ouvrirAccesApp(auth, id);
  }

  @Put(':id/photo')
  @Permission('membre.modifier')
  async photo(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Req() req: FastifyRequest) {
    return this.membres.remplacerPhoto(auth, id, await lireImageMultipart(req));
  }

  @Get(':id/situation')
  @Permission('membre.lire')
  situation(@Param('id', idPipe) id: string) {
    return this.requetes.situation(id);
  }

  @Get(':id/historique')
  @Permission('membre.lire')
  historique(@Param('id', idPipe) id: string, @Query() query: unknown) {
    const f = valider(pageSchema, query);
    return this.requetes.historique(id, lireLimite(f.limite), f.curseur);
  }

  /** RF-023, RG-MBR-008 : carte PDF (format ID-1) avec QR signé. */
  @Get(':id/carte')
  @Permission('membre.lire')
  async carte(@Param('id', idPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { contenu, nomFichier } = await this.cartes.pdf(id);
    void reply.type('application/pdf').header('content-disposition', `inline; filename="${nomFichier}"`);
    return contenu;
  }

  @Get(':id/ayants-droit')
  @Permission('membre.lire')
  listerAyantsDroit(@Param('id', idPipe) id: string) {
    return this.ayantsDroit.lister(id);
  }

  @Post(':id/ayants-droit')
  @Permission('membre.modifier')
  async creerAyantDroit(
    @Auth() auth: AuthRequete,
    @Param('id', idPipe) id: string,
    @Body() corps: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { dto, cree } = await this.ayantsDroit.creer(auth, id, valider(ayantDroitSchema, corps));
    void reply.status(cree ? 201 : 200);
    return dto;
  }

  @Patch(':id/ayants-droit/:ayantDroitId')
  @Permission('membre.modifier')
  modifierAyantDroit(
    @Auth() auth: AuthRequete,
    @Param('id', idPipe) id: string,
    @Param('ayantDroitId', idPipe) ayantDroitId: string,
    @Body() corps: unknown,
  ) {
    return this.ayantsDroit.modifier(auth, id, ayantDroitId, valider(ayantDroitMajSchema, corps));
  }

  @Delete(':id/ayants-droit/:ayantDroitId')
  @HttpCode(204)
  @Permission('membre.modifier')
  async supprimerAyantDroit(
    @Auth() auth: AuthRequete,
    @Param('id', idPipe) id: string,
    @Param('ayantDroitId', idPipe) ayantDroitId: string,
  ): Promise<void> {
    await this.ayantsDroit.supprimer(auth, id, ayantDroitId);
  }
}

/** Familles (E3-05). */
@Controller('familles')
export class FamillesController {
  constructor(private readonly familles: FamillesService) {}

  @Get()
  @Permission('membre.lire')
  lister(@Query() query: unknown) {
    const f = valider(pageSchema, query);
    return this.familles.lister({ q: f.q, curseur: f.curseur, limite: lireLimite(f.limite) });
  }

  @Post()
  @Permission('membre.creer')
  async creer(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { dto, cree } = await this.familles.creer(auth, valider(familleSchema, corps));
    void reply.status(cree ? 201 : 200);
    return dto;
  }

  @Patch(':id')
  @Permission('membre.modifier')
  modifier(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.familles.modifier(auth, id, valider(familleMajSchema, corps));
  }

  @Get(':id/membres')
  @Permission('membre.lire')
  membres(@Param('id', idPipe) id: string) {
    return this.familles.membresDe(id);
  }
}

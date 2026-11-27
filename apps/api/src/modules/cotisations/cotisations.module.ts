import { Body, Controller, Get, Headers, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import {
  campagneCreationSchema,
  campagneMajSchema,
  campagneMembresSchema,
  echeanceMajSchema,
  motifSchema,
  SITUATIONS_ECHEANCE,
  STATUTS_CAMPAGNE,
  TYPES_CAMPAGNE,
} from '@assoflow/contracts';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { idPipe } from '../utilisateurs/acces.controller.js';
import { AvancesService } from './avances.service.js';
import { CampagnesService } from './campagnes.service.js';
import { EcheancesService } from './echeances.service.js';

const filtresCampagnes = z.object({
  exerciceId: z.uuid().optional(),
  statut: z.enum(STATUTS_CAMPAGNE).optional(),
  type: z.enum(TYPES_CAMPAGNE).optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

const filtresEcheances = z.object({
  campagneId: z.uuid().optional(),
  membreId: z.uuid().optional(),
  situation: z.enum(SITUATIONS_ECHEANCE).optional(),
  du: z.iso.date().optional(),
  au: z.iso.date().optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

const filtresEcheancier = z.object({
  q: z.string().max(100).optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

/** Campagnes de cotisation (E4-01 à E4-03, RF-030, RF-031, RF-037, RF-075). */
@Controller('campagnes')
export class CampagnesController {
  constructor(
    private readonly campagnes: CampagnesService,
    private readonly echeances: EcheancesService,
  ) {}

  @Get()
  @Permission('cotisation.lire')
  lister(@Query() query: unknown) {
    const f = valider(filtresCampagnes, query);
    return this.campagnes.lister({ ...f, limite: lireLimite(f.limite) });
  }

  @Post()
  @Permission('cotisation.gerer')
  creer(@Auth() auth: AuthRequete, @Body() corps: unknown, @Headers('idempotency-key') cle?: string) {
    return this.campagnes.creer(auth, valider(campagneCreationSchema, corps), cle);
  }

  @Get(':id')
  @Permission('cotisation.lire')
  lire(@Param('id', idPipe) id: string) {
    return this.campagnes.lire(id);
  }

  @Patch(':id')
  @Permission('cotisation.gerer')
  modifier(
    @Auth() auth: AuthRequete,
    @Param('id', idPipe) id: string,
    @Body() corps: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.campagnes.modifier(auth, id, valider(campagneMajSchema, corps), ifMatch);
  }

  @Get(':id/apercu')
  @Permission('cotisation.lire')
  apercu(@Param('id', idPipe) id: string) {
    return this.campagnes.apercu(id);
  }

  @Post(':id/activer')
  @HttpCode(200)
  @Permission('cotisation.gerer')
  activer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.campagnes.activer(auth, id);
  }

  @Post(':id/cloturer')
  @HttpCode(200)
  @Permission('cotisation.gerer')
  cloturer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.campagnes.cloturer(auth, id);
  }

  @Post(':id/membres')
  @HttpCode(200)
  @Permission('cotisation.gerer')
  ajouterMembres(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    const c = valider(campagneMembresSchema, corps);
    return this.campagnes.ajouterMembres(auth, id, c.membreIds, c.rattrapage ?? false);
  }

  @Get(':id/statistiques')
  @Permission('cotisation.lire')
  statistiques(@Param('id', idPipe) id: string) {
    return this.campagnes.statistiques(id);
  }

  @Get(':id/echeancier')
  @Permission('cotisation.lire')
  echeancier(@Param('id', idPipe) id: string, @Query() query: unknown) {
    const f = valider(filtresEcheancier, query);
    return this.echeances.echeancier(id, { q: f.q, curseur: f.curseur, limite: lireLimite(f.limite) });
  }
}

/** Échéances (E4-04, RF-031, RF-035). */
@Controller('echeances')
export class EcheancesController {
  constructor(private readonly echeances: EcheancesService) {}

  @Get()
  @Permission('cotisation.lire')
  lister(@Query() query: unknown) {
    const f = valider(filtresEcheances, query);
    return this.echeances.lister({ ...f, limite: lireLimite(f.limite) });
  }

  @Patch(':id')
  @Permission('cotisation.gerer')
  ajuster(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.echeances.ajuster(auth, id, valider(echeanceMajSchema, corps));
  }

  @Post(':id/exonerer')
  @HttpCode(200)
  @Permission('cotisation.exonerer')
  exonerer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.echeances.exonerer(auth, id, valider(motifSchema, corps).motif);
  }
}

/** Cotisations : campagnes, échéancier, avances (E4-01 à E4-04). Paiements au sprint 4. */
@Module({
  controllers: [CampagnesController, EcheancesController],
  providers: [CampagnesService, EcheancesService, AvancesService],
  exports: [CampagnesService, AvancesService],
})
export class CotisationsModule {}

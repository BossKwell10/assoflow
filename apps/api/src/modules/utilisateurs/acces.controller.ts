import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { accesInvitationSchema, accesMajSchema, motifSchema } from '@assoflow/contracts';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { AccesService } from './acces.service.js';

const filtresSchema = z.object({
  statut: z.enum(['actif', 'revoque', 'expire']).optional(),
  roleId: z.uuid().optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

/** Un identifiant mal formé est traité comme une ressource absente (404, docs/04 §5). */
export const idPipe = new ParseUUIDPipe({
  exceptionFactory: () => new ErreurMetier('INTROUVABLE', 'Ressource introuvable'),
});

@Controller('acces')
export class AccesController {
  constructor(private readonly acces: AccesService) {}

  @Get()
  @Permission('utilisateur.lire')
  lister(@Query() query: unknown) {
    const f = valider(filtresSchema, query);
    return this.acces.lister({ ...f, limite: lireLimite(f.limite) });
  }

  @Post()
  @Permission('utilisateur.gerer')
  inviter(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Headers('idempotency-key') cle: string | undefined,
  ) {
    return this.acces.inviter(auth, valider(accesInvitationSchema, corps), cle);
  }

  @Patch(':id')
  @Permission('utilisateur.gerer')
  modifier(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.acces.modifier(auth, id, valider(accesMajSchema, corps));
  }

  @Post(':id/revoquer')
  @HttpCode(200)
  @Permission('utilisateur.gerer')
  revoquer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.acces.revoquer(auth, id, valider(motifSchema, corps).motif);
  }

  @Post(':id/deverrouiller')
  @HttpCode(204)
  @Permission('utilisateur.gerer')
  async deverrouiller(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string): Promise<void> {
    await this.acces.deverrouiller(auth, id);
  }
}

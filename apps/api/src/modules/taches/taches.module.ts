import { Controller, Get, Global, Module, Param } from '@nestjs/common';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth } from '../../common/auth/decorateurs.js';
import { FilesService } from '../../infra/files/files.js';
import { idPipe } from '../utilisateurs/acces.controller.js';
import { TachesService } from './taches.service.js';

/** Suivi des tâches asynchrones du demandeur (docs/07 : `GET /v1/taches`, `GET /v1/taches/{id}`). */
@Controller('taches')
export class TachesController {
  constructor(private readonly taches: TachesService) {}

  @Get()
  lister(@Auth() auth: AuthRequete) {
    return this.taches.lister(auth);
  }

  @Get(':id')
  lire(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.taches.lire(auth, id);
  }
}

/** Files BullMQ, tâches asynchrones et planifications (docs/06). */
@Global()
@Module({
  controllers: [TachesController],
  providers: [FilesService, TachesService],
  exports: [FilesService, TachesService],
})
export class TachesModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UtilisateursModule } from '../utilisateurs/utilisateurs.module.js';
import { AyantsDroitService } from './ayants-droit.service.js';
import { CarteMembreService } from './carte.service.js';
import { ImportMembresService } from './import/import.service.js';
import { DormanceService } from './dormance.service.js';
import { FamillesService } from './familles.service.js';
import { FamillesController, MembresController } from './membres.controller.js';
import { MembresLecture } from './membres.lecture.js';
import { MembresRequetes } from './membres.requetes.js';
import { MembresService } from './membres.service.js';

/** Membres, familles, ayants droit, import, carte (E3) ; dormance planifiée (RG-MBR-005). */
@Module({
  imports: [AuthModule, UtilisateursModule],
  controllers: [MembresController, FamillesController],
  providers: [
    MembresLecture,
    MembresService,
    MembresRequetes,
    FamillesService,
    AyantsDroitService,
    DormanceService,
    ImportMembresService,
    CarteMembreService,
  ],
  exports: [DormanceService, MembresService, CarteMembreService],
})
export class MembresModule {}

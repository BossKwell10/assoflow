import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccesController } from './acces.controller.js';
import { AccesService } from './acces.service.js';
import { PermissionsController, RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

/** Accès au bureau, rôles et permissions (E2-06, E2-07). */
@Module({
  imports: [AuthModule],
  controllers: [AccesController, RolesController, PermissionsController],
  providers: [AccesService, RolesService],
  exports: [AccesService],
})
export class UtilisateursModule {}

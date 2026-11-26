import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  LIBELLES_PERMISSIONS,
  PERMISSIONS,
  PERMISSIONS_RESERVEES_PRESIDENT,
  roleMajSchema,
  roleSchema,
} from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { valider } from '../../common/validation.js';
import { idPipe } from './acces.controller.js';
import { RolesService } from './roles.service.js';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Permission('utilisateur.lire')
  lister() {
    return this.roles.lister();
  }

  @Post()
  @Permission('role.gerer')
  creer(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.roles.creer(auth, valider(roleSchema, corps));
  }

  @Patch(':id')
  @Permission('role.gerer')
  modifier(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.roles.modifier(auth, id, valider(roleMajSchema, corps));
  }

  @Delete(':id')
  @HttpCode(204)
  @Permission('role.gerer')
  async supprimer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string): Promise<void> {
    await this.roles.supprimer(auth, id);
  }
}

@Controller('permissions')
export class PermissionsController {
  /** Catalogue des permissions (docs/04 §4). */
  @Get()
  @Permission('utilisateur.lire')
  lister() {
    return PERMISSIONS.map((code) => ({
      code,
      module: code.split('.')[0]!,
      libelle: LIBELLES_PERMISSIONS[code],
      reserveePresident: PERMISSIONS_RESERVEES_PRESIDENT.includes(code),
    }));
  }
}

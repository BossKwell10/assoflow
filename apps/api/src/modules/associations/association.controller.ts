import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import {
  associationMajSchema,
  categorieDepenseMajSchema,
  categorieDepenseSchema,
  categorieMembreMajSchema,
  categorieMembreSchema,
  exerciceSchema,
} from '@assoflow/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { lireImageMultipart } from '../../common/images.js';
import { valider } from '../../common/validation.js';
import { idPipe } from '../utilisateurs/acces.controller.js';
import { CategoriesService } from './categories.service.js';
import { ExercicesService } from './exercices.service.js';
import { ProfilAssociationService } from './profil.service.js';

/** Profil de l'association active (E2-03). */
@Controller('association')
export class AssociationController {
  constructor(private readonly profil: ProfilAssociationService) {}

  @Get()
  @Permission('association.lire')
  lire() {
    return this.profil.lire();
  }

  @Patch()
  @Permission('association.modifier')
  modifier(@Auth() auth: AuthRequete, @Body() corps: unknown, @Headers('if-match') ifMatch?: string) {
    return this.profil.modifier(auth, valider(associationMajSchema, corps), ifMatch);
  }

  @Put('logo')
  @Permission('association.modifier')
  async logo(@Auth() auth: AuthRequete, @Req() req: FastifyRequest) {
    return this.profil.remplacerLogo(auth, await lireImageMultipart(req));
  }
}

/** Exercices (E2-04). */
@Controller('exercices')
export class ExercicesController {
  constructor(private readonly exercices: ExercicesService) {}

  @Get()
  @Permission('association.lire')
  lister() {
    return this.exercices.lister();
  }

  @Post()
  @Permission('exercice.gerer')
  creer(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.exercices.creer(auth, valider(exerciceSchema, corps));
  }

  @Post(':id/cloturer')
  @HttpCode(200)
  @Permission('exercice.cloturer')
  cloturer(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.exercices.cloturer(auth, id);
  }
}

/** Catégories de membres et de dépenses (E2-05). */
@Controller()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('categories-membres')
  @Permission('membre.lire')
  listerMembres() {
    return this.categories.lister('membre');
  }

  @Post('categories-membres')
  @Permission('association.modifier')
  creerMembre(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.categories.creer(auth, 'membre', valider(categorieMembreSchema, corps));
  }

  @Patch('categories-membres/:id')
  @Permission('association.modifier')
  modifierMembre(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.categories.modifier(auth, 'membre', id, valider(categorieMembreMajSchema, corps));
  }

  @Get('categories-depense')
  @Permission('depense.lire')
  listerDepense() {
    return this.categories.lister('depense');
  }

  @Post('categories-depense')
  @Permission('association.modifier')
  creerDepense(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.categories.creer(auth, 'depense', valider(categorieDepenseSchema, corps));
  }

  @Patch('categories-depense/:id')
  @Permission('association.modifier')
  modifierDepense(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.categories.modifier(auth, 'depense', id, valider(categorieDepenseMajSchema, corps));
  }
}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import {
  AssociationController,
  CategoriesController,
  ExercicesController,
} from './association.controller.js';
import { AssociationsService } from './associations.service.js';
import { CategoriesService } from './categories.service.js';
import { ExercicesService } from './exercices.service.js';
import { ProfilAssociationService } from './profil.service.js';

/** Association active : profil, exercices, catégories (E2-03 à E2-05) ; création de tenant (service). */
@Module({
  imports: [AuthModule],
  controllers: [AssociationController, ExercicesController, CategoriesController],
  providers: [AssociationsService, ProfilAssociationService, ExercicesService, CategoriesService],
  exports: [AssociationsService],
})
export class AssociationsModule {}

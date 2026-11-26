import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AssociationsService } from './associations.service.js';

/** Sprint 1 : création de tenant (service) pour le seed et les tests ; endpoints au sprint 2/7. */
@Module({
  imports: [AuthModule],
  providers: [AssociationsService],
  exports: [AssociationsService],
})
export class AssociationsModule {}

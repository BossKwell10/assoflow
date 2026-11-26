import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ComptesService } from './comptes.service.js';
import { JetonsService } from './jetons.service.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, ComptesService, JetonsService, SessionsService],
  exports: [ComptesService, JetonsService, SessionsService],
})
export class AuthModule {}

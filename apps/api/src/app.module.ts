import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './common/auth/auth.guard.js';
import { ContexteInterceptor } from './common/auth/contexte.interceptor.js';
import { EtagInterceptor } from './common/concurrence.js';
import { ProblemeFilter } from './common/probleme.filter.js';
import { InfraModule } from './infra/infra.module.js';
import { AssociationsModule } from './modules/associations/associations.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { UtilisateursModule } from './modules/utilisateurs/utilisateurs.module.js';

@Module({
  imports: [InfraModule, AuthModule, UtilisateursModule, AssociationsModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemeFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: ContexteInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
  ],
})
export class AppModule {}

import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DatabaseService } from '../../infra/database.js';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /** Le processus répond (healthcheck Docker). */
  @Get('live')
  @HttpCode(200)
  live(): { statut: 'ok' } {
    return { statut: 'ok' };
  }

  /** Les dépendances sont joignables (retrait du service si 503). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reponse: FastifyReply) {
    const base = this.db.configuree ? ((await this.db.ping()) ? 'ok' : 'ko') : 'non_configuree';
    const statut = base === 'ko' ? 'degrade' : 'ok';
    void reponse.status(statut === 'ok' ? 200 : 503);
    return { statut, dependances: { postgres: base } };
  }
}

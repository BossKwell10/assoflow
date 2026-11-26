import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/auth/decorateurs.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { StockageLocal } from './stockage-local.js';
import { STOCKAGE_OBJETS, type StockageObjets } from './stockage-objets.js';

/** Lecture des fichiers du stockage local par URL signée (équivalent des URL présignées S3, hors production). */
@Controller('fichiers')
export class FichiersController {
  constructor(@Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets) {}

  @Get()
  @Public()
  async lire(
    @Query('c') jeton: string | undefined,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const fichier = this.stockage instanceof StockageLocal ? await this.stockage.lire(jeton, exp, sig) : null;
    if (!fichier) throw new ErreurMetier('INTROUVABLE', 'Fichier introuvable ou lien expiré');
    await reply
      .header('content-type', fichier.type)
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(fichier.contenu);
  }
}

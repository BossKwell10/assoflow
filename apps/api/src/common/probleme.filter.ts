import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { CODES_ERREUR, type CodeErreur, type ErreurProbleme } from '@assoflow/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErreurMetier } from './erreur-metier.js';

const CODE_PAR_STATUT: Record<number, CodeErreur> = {
  400: 'REQUETE_MALFORMEE',
  401: 'NON_AUTHENTIFIE',
  403: 'PERMISSION_REFUSEE',
  404: 'INTROUVABLE',
  409: 'ETAT_INCOMPATIBLE',
  412: 'PRECONDITION_ECHOUEE',
  422: 'VALIDATION',
  429: 'TROP_DE_REQUETES',
};

/** Transforme toute exception en `application/problem+json`, sans jamais exposer de pile d'appel. */
@Catch()
export class ProblemeFilter implements ExceptionFilter {
  private readonly logger = new Logger('Erreurs');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reponse = ctx.getResponse<FastifyReply>();
    const requete = ctx.getRequest<FastifyRequest>();
    const corps = this.versProbleme(exception, String(requete.id));
    if (corps.status >= 500)
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    void reponse.status(corps.status).header('content-type', 'application/problem+json').send(corps);
  }

  versProbleme(exception: unknown, requestId: string): ErreurProbleme {
    if (exception instanceof ErreurMetier) {
      return {
        type: `https://docs.assoflow.ci/erreurs/${exception.code}`,
        title: exception.code,
        status: exception.status,
        code: exception.code,
        detail: exception.detail,
        requestId,
        erreurs: exception.erreurs,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_PAR_STATUT[status] ?? (status >= 500 ? 'ERREUR_INTERNE' : 'REQUETE_MALFORMEE');
      return {
        type: `https://docs.assoflow.ci/erreurs/${code}`,
        title: code,
        status,
        code,
        detail: status >= 500 ? 'Erreur interne' : exception.message,
        requestId,
      };
    }
    return {
      type: 'https://docs.assoflow.ci/erreurs/ERREUR_INTERNE',
      title: 'ERREUR_INTERNE',
      status: CODES_ERREUR.ERREUR_INTERNE,
      code: 'ERREUR_INTERNE',
      detail: 'Erreur interne',
      requestId,
    };
  }
}

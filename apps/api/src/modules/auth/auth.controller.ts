import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  connexionSchema,
  contexteSchema,
  ENTETE_CONSOLE,
  motDePasseSchema,
  otpDemanderSchema,
  otpVerifierSchema,
  refreshSchema,
  totpConfirmationSchema,
  totpSchema,
} from '@assoflow/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { AccepteJetonIntermediaire, Auth, HorsTenant, Public } from '../../common/auth/decorateurs.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { valider } from '../../common/validation.js';
import { AuthService, type SessionEmise } from './auth.service.js';

/** Cookie du refresh token console (docs/04 §3). */
export const COOKIE_REFRESH = 'assoflow_refresh';
const CHEMIN_COOKIE = '/v1/auth';

function lireCookie(req: FastifyRequest, nom: string): string | undefined {
  const brut = req.headers.cookie;
  if (!brut) return undefined;
  for (const morceau of brut.split(';')) {
    const i = morceau.indexOf('=');
    if (i > 0 && morceau.slice(0, i).trim() === nom) return decodeURIComponent(morceau.slice(i + 1).trim());
  }
  return undefined;
}

/** Corps `Session` (openapi) ; console : refresh en cookie HttpOnly, jamais dans le corps. */
function versSession(reponse: FastifyReply, s: SessionEmise) {
  if (s.canal === 'console' && s.refreshToken && s.refreshExpireAt) {
    const maxAge = Math.max(0, Math.floor((s.refreshExpireAt.getTime() - Date.now()) / 1000));
    void reponse.header(
      'set-cookie',
      `${COOKIE_REFRESH}=${s.refreshToken}; Max-Age=${maxAge}; Path=${CHEMIN_COOKIE}; HttpOnly; Secure; SameSite=Strict`,
    );
  }
  return {
    accessToken: s.accessToken,
    expireDans: s.expireDans,
    ...(s.canal === 'mobile' && s.refreshToken ? { refreshToken: s.refreshToken } : {}),
    utilisateur: s.utilisateur,
  };
}

function effacerCookie(reponse: FastifyReply): void {
  void reponse.header(
    'set-cookie',
    `${COOKIE_REFRESH}=; Max-Age=0; Path=${CHEMIN_COOKIE}; HttpOnly; Secure; SameSite=Strict`,
  );
}

const userAgent = (req: FastifyRequest) => req.headers['user-agent'];

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/demander')
  @HttpCode(204)
  async demanderOtp(@Body() corps: unknown): Promise<void> {
    await this.auth.demanderOtp(valider(otpDemanderSchema, corps));
  }

  @Public()
  @Post('otp/verifier')
  @HttpCode(200)
  verifierOtp(@Body() corps: unknown) {
    return this.auth.verifierOtp(valider(otpVerifierSchema, corps));
  }

  @Public()
  @Post('mot-de-passe')
  @HttpCode(204)
  async definirMotDePasse(@Body() corps: unknown): Promise<void> {
    await this.auth.definirMotDePasse(valider(motDePasseSchema, corps));
  }

  @Public()
  @Post('connexion')
  @HttpCode(200)
  async connexion(
    @Body() corps: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) rep: FastifyReply,
  ) {
    const r = await this.auth.connecter({ ...valider(connexionSchema, corps), userAgent: userAgent(req) });
    if (r.type === 'etape') return { etape: r.etape, jetonIntermediaire: r.jetonIntermediaire };
    return versSession(rep, r.session);
  }

  @Public()
  @Post('totp')
  @HttpCode(200)
  async totp(
    @Body() corps: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) rep: FastifyReply,
  ) {
    return versSession(
      rep,
      await this.auth.terminerTotp({ ...valider(totpSchema, corps), userAgent: userAgent(req) }),
    );
  }

  @HorsTenant()
  @AccepteJetonIntermediaire()
  @Post('totp/activation')
  @HttpCode(200)
  activationTotp(@Auth() auth: AuthRequete) {
    return this.auth.demarrerActivationTotp(auth);
  }

  @HorsTenant()
  @AccepteJetonIntermediaire()
  @Post('totp/confirmation')
  @HttpCode(200)
  async confirmationTotp(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) rep: FastifyReply,
  ) {
    const { code } = valider(totpConfirmationSchema, corps);
    const r = await this.auth.confirmerTotp(auth, code, userAgent(req));
    return r.session ? { codesSecours: r.codesSecours, session: versSession(rep, r.session) } : r;
  }

  /**
   * Console : cookie HttpOnly + en-tête `X-Requested-With: assoflow-console` (anti-CSRF, docs/04 §10).
   * Mobile : `refreshToken` dans le corps.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() corps: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) rep: FastifyReply,
  ) {
    const { refreshToken } = valider(refreshSchema, corps);
    if (refreshToken)
      return versSession(rep, await this.auth.rafraichir(refreshToken, 'mobile', userAgent(req)));
    const cookie = lireCookie(req, COOKIE_REFRESH);
    if (!cookie) throw new ErreurMetier('NON_AUTHENTIFIE', 'Aucune session à renouveler');
    if (req.headers[ENTETE_CONSOLE.nom] !== ENTETE_CONSOLE.valeur) {
      throw new ErreurMetier('NON_AUTHENTIFIE', `En-tête X-Requested-With: ${ENTETE_CONSOLE.valeur} requis`);
    }
    try {
      return versSession(rep, await this.auth.rafraichir(cookie, 'console', userAgent(req)));
    } catch (e) {
      effacerCookie(rep);
      throw e;
    }
  }

  @HorsTenant()
  @Post('deconnexion')
  @HttpCode(204)
  async deconnexion(@Auth() auth: AuthRequete, @Res({ passthrough: true }) rep: FastifyReply): Promise<void> {
    await this.auth.deconnecter(auth);
    if (auth.canal === 'console') effacerCookie(rep);
  }

  @HorsTenant()
  @Get('moi')
  moi(@Auth() auth: AuthRequete) {
    return this.auth.moi(auth.userId);
  }

  @HorsTenant()
  @Post('contexte')
  @HttpCode(200)
  async contexte(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Res({ passthrough: true }) rep: FastifyReply,
  ) {
    const { associationId } = valider(contexteSchema, corps);
    return versSession(rep, await this.auth.choisirContexte(auth, associationId));
  }
}

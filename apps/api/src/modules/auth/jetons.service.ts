import { Injectable } from '@nestjs/common';
import type { ButOtp, Canal } from '@assoflow/contracts';
import { errors, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { SecretsService } from '../../infra/secrets.js';

const EMETTEUR = 'assoflow';
const AUDIENCE_API = 'assoflow:api';
const AUDIENCE_MFA = 'assoflow:mfa';
const AUDIENCE_OTP = 'assoflow:otp';

/** Durées des jetons (docs/04 §3). */
export const DUREES = {
  accesConsole: 10 * 60,
  accesMobile: 15 * 60,
  intermediaire: 5 * 60,
  jetonOtp: 10 * 60,
} as const;

/** Claims de l'access token (docs/04 §3). Les permissions n'y figurent jamais. */
export interface ClaimsAcces {
  sub: string;
  sid: string;
  aid?: string;
  can: Canal;
  dev?: string;
  imp?: string;
  pf?: 'super_admin' | 'support';
}

export type EtapeMfa = 'totp' | 'totp_activation';

export interface ClaimsIntermediaire {
  sub: string;
  can: Canal;
  etp: EtapeMfa;
}

export interface ClaimsJetonOtp {
  sub: string;
  jti: string;
  but: ButOtp;
}

/** Émission et vérification des jetons JWT EdDSA (Ed25519) via `jose`. */
@Injectable()
export class JetonsService {
  constructor(private readonly secrets: SecretsService) {}

  dureeAcces(canal: Canal): number {
    return canal === 'console' ? DUREES.accesConsole : DUREES.accesMobile;
  }

  async signerAcces(claims: ClaimsAcces): Promise<{ jeton: string; expireDans: number }> {
    const expireDans = this.dureeAcces(claims.can);
    const charge: JWTPayload = { sid: claims.sid, can: claims.can };
    if (claims.aid) charge.aid = claims.aid;
    if (claims.dev) charge.dev = claims.dev;
    if (claims.imp) charge.imp = claims.imp;
    if (claims.pf) charge.pf = claims.pf;
    return { jeton: await this.signer(charge, claims.sub, AUDIENCE_API, expireDans), expireDans };
  }

  async signerIntermediaire(claims: ClaimsIntermediaire): Promise<string> {
    return this.signer({ can: claims.can, etp: claims.etp }, claims.sub, AUDIENCE_MFA, DUREES.intermediaire);
  }

  async signerJetonOtp(claims: ClaimsJetonOtp): Promise<string> {
    return this.signer({ jti: claims.jti, but: claims.but }, claims.sub, AUDIENCE_OTP, DUREES.jetonOtp);
  }

  /** Vérifie un jeton Bearer : access token, ou jeton intermédiaire si `accepterIntermediaire`. */
  async verifierBearer(
    jeton: string,
    accepterIntermediaire: boolean,
  ): Promise<
    { type: 'acces'; claims: ClaimsAcces } | { type: 'intermediaire'; claims: ClaimsIntermediaire }
  > {
    const audiences = accepterIntermediaire ? [AUDIENCE_API, AUDIENCE_MFA] : [AUDIENCE_API];
    const charge = await this.verifier(jeton, audiences, 'NON_AUTHENTIFIE');
    if (charge.aud === AUDIENCE_MFA || (Array.isArray(charge.aud) && charge.aud.includes(AUDIENCE_MFA))) {
      return { type: 'intermediaire', claims: this.versIntermediaire(charge) };
    }
    if (typeof charge.sid !== 'string' || (charge.can !== 'console' && charge.can !== 'mobile')) {
      throw new ErreurMetier('NON_AUTHENTIFIE', 'Jeton invalide');
    }
    return {
      type: 'acces',
      claims: {
        sub: charge.sub!,
        sid: charge.sid,
        can: charge.can,
        aid: typeof charge.aid === 'string' ? charge.aid : undefined,
        dev: typeof charge.dev === 'string' ? charge.dev : undefined,
        imp: typeof charge.imp === 'string' ? charge.imp : undefined,
        pf: charge.pf === 'super_admin' || charge.pf === 'support' ? charge.pf : undefined,
      },
    };
  }

  async verifierIntermediaire(jeton: string): Promise<ClaimsIntermediaire> {
    return this.versIntermediaire(await this.verifier(jeton, [AUDIENCE_MFA], 'NON_AUTHENTIFIE'));
  }

  async verifierJetonOtp(jeton: string): Promise<ClaimsJetonOtp> {
    const charge = await this.verifier(jeton, [AUDIENCE_OTP], 'OTP_EXPIRE');
    if (typeof charge.jti !== 'string' || typeof charge.but !== 'string') {
      throw new ErreurMetier('OTP_INVALIDE', 'Jeton OTP invalide');
    }
    return { sub: charge.sub!, jti: charge.jti, but: charge.but as ButOtp };
  }

  private versIntermediaire(charge: JWTPayload): ClaimsIntermediaire {
    if (
      (charge.can !== 'console' && charge.can !== 'mobile') ||
      (charge.etp !== 'totp' && charge.etp !== 'totp_activation')
    ) {
      throw new ErreurMetier('NON_AUTHENTIFIE', 'Jeton intermédiaire invalide');
    }
    return { sub: charge.sub!, can: charge.can, etp: charge.etp };
  }

  private async signer(charge: JWTPayload, sub: string, audience: string, dureeS: number): Promise<string> {
    return new SignJWT(charge)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(EMETTEUR)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${dureeS}s`)
      .sign(this.secrets.clePriveeJwt);
  }

  private async verifier(
    jeton: string,
    audiences: string[],
    codeExpire: 'NON_AUTHENTIFIE' | 'OTP_EXPIRE',
  ): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(jeton, this.secrets.clePubliqueJwt, {
        issuer: EMETTEUR,
        audience: audiences,
        algorithms: ['EdDSA'],
      });
      if (typeof payload.sub !== 'string') throw new Error('sub manquant');
      return payload;
    } catch (e) {
      if (e instanceof errors.JWTExpired) {
        throw codeExpire === 'OTP_EXPIRE'
          ? new ErreurMetier('OTP_EXPIRE', 'Le délai pour définir le mot de passe est dépassé')
          : new ErreurMetier('JETON_EXPIRE', 'Jeton expiré');
      }
      throw codeExpire === 'OTP_EXPIRE'
        ? new ErreurMetier('OTP_INVALIDE', 'Jeton OTP invalide')
        : new ErreurMetier('NON_AUTHENTIFIE', 'Jeton invalide');
    }
  }
}

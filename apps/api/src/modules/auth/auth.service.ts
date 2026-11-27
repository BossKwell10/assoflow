import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MESSAGES_MOT_DE_PASSE,
  VERSION_CGU,
  normaliserTelephone,
  verifierMotDePasse,
  type ButOtp,
  type Canal,
} from '@assoflow/contracts';
import { contexteCourant, type ContexteRequete } from '../../common/contexte.js';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { SecretsService } from '../../infra/secrets.js';
import { FOURNISSEUR_SMS, type FournisseurSms } from '../../infra/sms/fournisseur-sms.js';
import { AuditService } from '../audit/audit.service.js';
import { hacherMotDePasse, verifierMotDePasseHache } from './domain/argon2.js';
import { chiffrer, dechiffrer } from './domain/chiffrement.js';
import {
  egalEnTempsConstant,
  genererCodeOtp,
  genererCodesSecours,
  hmacPoivre,
  normaliserCodeSecours,
} from './domain/hachage.js';
import { encoderBase32, genererSecretTotp, urlOtpauth, verifierTotp } from './domain/totp.js';
import { calculerVerrouillage, ECHECS_AVANT_VERROUILLAGE } from './domain/verrouillage.js';
import { JetonsService, type EtapeMfa } from './jetons.service.js';
import { SessionsService, type NouvelleSession } from './sessions.service.js';

/** OTP : 6 chiffres, 5 min, 5 essais ; 3 demandes par numéro par 15 min (docs/04 §2.1, §9). */
export const OTP = {
  dureeMs: 5 * 60_000,
  essais: 5,
  demandesMax: 3,
  fenetreDemandesMs: 15 * 60_000,
} as const;

export interface AccesResume {
  associationId: string;
  associationNom: string;
  role: { code: string; libelle: string };
  permissions: string[];
}

export interface UtilisateurMoi {
  id: string;
  telephone: string;
  email: string | null;
  nom: string;
  prenoms: string;
  totpActif: boolean;
  rolePlateforme: 'super_admin' | 'support' | null;
  acces: AccesResume[];
}

export interface SessionEmise {
  accessToken: string;
  expireDans: number;
  /** Renvoyé dans le corps pour le mobile ; posé en cookie pour la console (contrôleur). */
  refreshToken?: string;
  refreshExpireAt?: Date;
  canal: Canal;
  utilisateur: UtilisateurMoi;
}

export type ResultatConnexion =
  { type: 'session'; session: SessionEmise } | { type: 'etape'; etape: EtapeMfa; jetonIntermediaire: string };

interface LigneUser {
  id: string;
  telephone: string;
  email: string | null;
  nom: string;
  prenoms: string;
  mot_de_passe_hash: string | null;
  totp_secret_chiffre: Buffer | null;
  totp_actif: boolean;
  totp_dernier_pas: string | null;
  codes_secours_hash: string[];
  echecs_connexion: number;
  verrouille_jusqua: Date | null;
  verrouillages_recents: number;
  dernier_verrouillage: Date | null;
  role_plateforme: 'super_admin' | 'support' | null;
  statut: string;
}

interface LigneMesAcces {
  acces_id: string;
  association_id: string;
  association_nom: string;
  association_statut: string;
  role_code: string;
  role_libelle: string;
  permissions: string[];
  en_cours: boolean;
}

const COLONNES_USER = `id, telephone, email::text AS email, nom, prenoms, mot_de_passe_hash, totp_secret_chiffre,
  totp_actif, totp_dernier_pas, codes_secours_hash, echecs_connexion, verrouille_jusqua, verrouillages_recents,
  dernier_verrouillage, role_plateforme, statut`;

/** Hash argon2id factice : vérifié quand l'identifiant est inconnu (temps de réponse homogène). */
let hashFactice: Promise<string> | undefined;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly db: DatabaseService,
    private readonly jetons: JetonsService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly secrets: SecretsService,
    @Inject(FOURNISSEUR_SMS) private readonly sms: FournisseurSms,
  ) {}

  // ---------------------------------------------------------------------------
  // OTP (RF-001, RF-004)
  // ---------------------------------------------------------------------------

  /**
   * Demande d'OTP. Répond toujours sans révéler si le numéro a un compte : le SMS n'est envoyé
   * qu'aux comptes actifs. Limite : 3 demandes par numéro par 15 min → 429.
   */
  async demanderOtp(p: { telephone: string; but: ButOtp }): Promise<void> {
    const ctx = this.ctx();
    const envoi = await this.db.tx(async (tx) => {
      const recentes = await tx.query<{ n: number; plus_ancienne: Date | null }>(
        `SELECT count(*)::int AS n, min(created_at) AS plus_ancienne FROM otp_codes
          WHERE telephone = $1 AND created_at > now() - make_interval(secs => $2)`,
        [p.telephone, OTP.fenetreDemandesMs / 1000],
      );
      const { n, plus_ancienne } = recentes.rows[0]!;
      if (n >= OTP.demandesMax) {
        const attente = plus_ancienne
          ? Math.max(1, Math.ceil((plus_ancienne.getTime() + OTP.fenetreDemandesMs - Date.now()) / 1000))
          : 60;
        throw new ErreurMetier(
          'TROP_DE_REQUETES',
          'Trop de demandes de code pour ce numéro. Réessayez plus tard.',
          [],
          { 'retry-after': String(attente) },
        );
      }
      const u = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE telephone = $1 AND statut = 'actif'`,
        [p.telephone],
      );
      if (!u.rows[0]) return null;
      const code = genererCodeOtp();
      const r = await tx.query<{ id: string }>(
        `INSERT INTO otp_codes (telephone, but, code_hash, expire_at, ip)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5) RETURNING id`,
        [p.telephone, p.but, this.hmacOtp(p.telephone, p.but, code), OTP.dureeMs / 1000, ctx.ip ?? null],
      );
      return { id: r.rows[0]!.id, code };
    }, ctx);
    if (!envoi) return;
    // Hors transaction (docs/06 §1). L'outbox fiable arrive au sprint 4.
    try {
      await this.sms.envoyer({
        to: p.telephone,
        texte: `AssoFlow : votre code est ${envoi.code}. Il expire dans 5 minutes. Ne le communiquez à personne.`,
        ref: `otp:${envoi.id}`,
      });
    } catch (e) {
      this.logger.error(`Envoi de l'OTP ${envoi.id} impossible : ${(e as Error).message}`);
    }
  }

  async verifierOtp(p: {
    telephone: string;
    code: string;
    but: ButOtp;
  }): Promise<{ jetonOtp: string; expireDans: number }> {
    const ctx = this.ctx();
    const resultat = await this.db.tx(async (tx) => {
      const r = await tx.query<{ id: string; code_hash: string; tentatives: number; expire: boolean }>(
        `SELECT id, code_hash, tentatives, expire_at <= now() AS expire FROM otp_codes
          WHERE telephone = $1 AND but = $2 AND consomme_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [p.telephone, p.but],
      );
      const otp = r.rows[0];
      if (!otp) return { statut: 'invalide' as const };
      if (otp.expire) return { statut: 'expire' as const };
      if (otp.tentatives >= OTP.essais) return { statut: 'epuise' as const };
      if (!egalEnTempsConstant(otp.code_hash, this.hmacOtp(p.telephone, p.but, p.code))) {
        await tx.query(`UPDATE otp_codes SET tentatives = tentatives + 1 WHERE id = $1`, [otp.id]);
        return { statut: 'invalide' as const };
      }
      const u = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE telephone = $1 AND statut = 'actif'`,
        [p.telephone],
      );
      if (!u.rows[0]) return { statut: 'invalide' as const };
      await tx.query(`UPDATE otp_codes SET consomme_at = now() WHERE id = $1`, [otp.id]);
      return { statut: 'ok' as const, otpId: otp.id, userId: u.rows[0].id };
    }, ctx);
    switch (resultat.statut) {
      case 'expire':
        throw new ErreurMetier('OTP_EXPIRE', 'Ce code a expiré. Demandez un nouveau code.');
      case 'epuise':
        throw new ErreurMetier('OTP_INVALIDE', "Nombre d'essais dépassé. Demandez un nouveau code.");
      case 'invalide':
        throw new ErreurMetier('OTP_INVALIDE', 'Code incorrect.');
    }
    const jetonOtp = await this.jetons.signerJetonOtp({
      sub: resultat.userId,
      jti: resultat.otpId,
      but: p.but,
    });
    return { jetonOtp, expireDans: 600 };
  }

  // ---------------------------------------------------------------------------
  // Mot de passe et consentements (RF-004, RF-SUP-053, RF-SUP-054)
  // ---------------------------------------------------------------------------

  async definirMotDePasse(p: {
    jetonOtp: string;
    motDePasse: string;
    accepteCgu?: boolean;
    accepteTraitementDonnees?: boolean;
    canal?: Canal;
  }): Promise<void> {
    const claims = await this.jetons.verifierJetonOtp(p.jetonOtp);
    if (claims.but !== 'inscription' && claims.but !== 'reinitialisation') {
      throw new ErreurMetier('OTP_INVALIDE', 'Ce code ne permet pas de définir un mot de passe');
    }
    const ctx = { ...this.ctx(), userId: claims.sub };
    const user = await this.db.tx((tx) => this.chargerUser(tx, claims.sub), ctx);
    if (!user || user.statut !== 'actif') throw new ErreurMetier('OTP_INVALIDE', 'Jeton OTP invalide');

    // RF-SUP-053 : politique de mot de passe.
    const problemes = verifierMotDePasse(p.motDePasse, user.telephone);
    if (problemes.length > 0) {
      throw new ErreurMetier(
        'MOT_DE_PASSE_FAIBLE',
        problemes.map((x) => MESSAGES_MOT_DE_PASSE[x]).join(' '),
        problemes.map((x) => ({ champ: 'motDePasse', code: x, message: MESSAGES_MOT_DE_PASSE[x] })),
      );
    }
    const motDePasseHash = await hacherMotDePasse(p.motDePasse);

    await this.db.tx(async (tx) => {
      // Jeton OTP à usage unique.
      const o = await tx.query<{ telephone: string }>(
        `UPDATE otp_codes SET jeton_utilise_at = now()
          WHERE id = $1 AND consomme_at IS NOT NULL AND jeton_utilise_at IS NULL RETURNING telephone`,
        [claims.jti],
      );
      if (o.rows[0]?.telephone !== user.telephone)
        throw new ErreurMetier('OTP_INVALIDE', 'Jeton OTP déjà utilisé');

      // RF-SUP-054 : CGU et traitement des données, version courante, à la première définition.
      const c = await tx.query<{ type: string }>(
        `SELECT DISTINCT type FROM consentements
          WHERE user_id = $1 AND version_texte = $2 AND accorde AND type IN ('cgu', 'traitement_donnees')`,
        [user.id, VERSION_CGU],
      );
      const dejaConsentis = new Set(c.rows.map((x) => x.type));
      const manquants = (['cgu', 'traitement_donnees'] as const).filter((t) => !dejaConsentis.has(t));
      if (manquants.length > 0) {
        const erreurs = [];
        if (manquants.includes('cgu') && p.accepteCgu !== true) {
          erreurs.push({
            champ: 'accepteCgu',
            code: 'CONSENTEMENT_REQUIS',
            message: 'Acceptez les conditions générales.',
          });
        }
        if (manquants.includes('traitement_donnees') && p.accepteTraitementDonnees !== true) {
          erreurs.push({
            champ: 'accepteTraitementDonnees',
            code: 'CONSENTEMENT_REQUIS',
            message: 'Acceptez le traitement de vos données personnelles.',
          });
        }
        if (erreurs.length > 0) throw new ErreurMetier('VALIDATION', 'Consentement requis', erreurs);
        for (const type of manquants) {
          await tx.query(
            `INSERT INTO consentements (user_id, type, version_texte, accorde, recueilli_par, canal)
             VALUES ($1, $2, $3, true, $1, $4)`,
            [user.id, type, VERSION_CGU, p.canal ?? 'mobile'],
          );
        }
      }

      await tx.query(
        `UPDATE users SET mot_de_passe_hash = $2, echecs_connexion = 0, verrouille_jusqua = NULL WHERE id = $1`,
        [user.id, motDePasseHash],
      );
      // RF-004 : une (ré)initialisation révoque toutes les sessions.
      await this.sessions.revoquerUtilisateur(tx, user.id);
      await this.audit.tracer(tx, {
        associationId: null,
        acteurId: user.id,
        action: 'utilisateur.mot_de_passe_defini',
        entiteType: 'utilisateur',
        entiteId: user.id,
        apres: { but: claims.but, consentements: manquants },
      });
    }, ctx);
  }

  // ---------------------------------------------------------------------------
  // Connexion (RF-002, RF-003, RF-005)
  // ---------------------------------------------------------------------------

  async connecter(p: {
    identifiant: string;
    motDePasse: string;
    canal: Canal;
    userAgent?: string;
  }): Promise<ResultatConnexion> {
    const ctx = this.ctx();
    const user = await this.db.tx((tx) => this.trouverParIdentifiant(tx, p.identifiant), ctx);

    if (!user) {
      await verifierMotDePasseHache(await this.hashFactice(), p.motDePasse);
      await this.tracerEchec(null, 'identifiant_inconnu', p.canal);
      throw this.identifiantsInvalides();
    }
    if (user.verrouille_jusqua && user.verrouille_jusqua.getTime() > Date.now()) {
      await this.tracerEchec(user.id, 'compte_verrouille', p.canal);
      throw this.compteVerrouille(user.verrouille_jusqua);
    }
    let valide = false;
    if (user.statut === 'actif' && user.mot_de_passe_hash !== null) {
      valide = await verifierMotDePasseHache(user.mot_de_passe_hash, p.motDePasse);
    } else {
      await verifierMotDePasseHache(await this.hashFactice(), p.motDePasse);
    }
    if (!valide) {
      await this.enregistrerEchec(user.id, 'mot_de_passe', p.canal);
      throw this.identifiantsInvalides();
    }

    const acces = await this.mesAcces(user.id);
    // RF-003 : TOTP sur la console pour tout rôle autre que `membre`, et toujours pour un rôle plateforme.
    const exigeTotp =
      user.role_plateforme !== null || (p.canal === 'console' && acces.some((a) => a.role_code !== 'membre'));
    if (exigeTotp) {
      const etape: EtapeMfa = user.totp_actif ? 'totp' : 'totp_activation';
      return {
        type: 'etape',
        etape,
        jetonIntermediaire: await this.jetons.signerIntermediaire({ sub: user.id, can: p.canal, etp: etape }),
      };
    }
    return {
      type: 'session',
      session: await this.ouvrirSession(user, p.canal, acces, p.userAgent, 'mot_de_passe'),
    };
  }

  /** Second facteur : code TOTP à 6 chiffres ou code de secours (à usage unique). */
  async terminerTotp(p: {
    jetonIntermediaire: string;
    code: string;
    userAgent?: string;
  }): Promise<SessionEmise> {
    const claims = await this.jetons.verifierIntermediaire(p.jetonIntermediaire);
    if (claims.etp !== 'totp') throw new ErreurMetier('NON_AUTHENTIFIE', 'Activez d’abord le TOTP');
    const ctx = { ...this.ctx(), userId: claims.sub };
    const user = await this.db.tx((tx) => this.chargerUser(tx, claims.sub), ctx);
    if (!user || user.statut !== 'actif' || !user.totp_actif || !user.totp_secret_chiffre) {
      throw new ErreurMetier('TOTP_INVALIDE', 'Code incorrect');
    }
    this.refuserSiVerrouille(user);

    const code = p.code.replace(/\s/g, '');
    let accepte = false;
    if (/^\d{6}$/.test(code)) {
      const secret = dechiffrer(user.totp_secret_chiffre, this.secrets.cleChiffrement);
      const pas = verifierTotp(secret, code, {
        dernierPas: user.totp_dernier_pas === null ? null : Number(user.totp_dernier_pas),
      });
      if (pas !== null) {
        accepte = await this.db.tx(async (tx) => {
          // Anti-rejeu : le pas doit progresser (concurrence comprise).
          const r = await tx.query(
            `UPDATE users SET totp_dernier_pas = $2 WHERE id = $1 AND (totp_dernier_pas IS NULL OR totp_dernier_pas < $2)`,
            [user.id, pas],
          );
          return (r.rowCount ?? 0) > 0;
        }, ctx);
      }
    } else {
      const empreinte = hmacPoivre(normaliserCodeSecours(code), this.secrets.poivreOtp);
      accepte = await this.db.tx(async (tx) => {
        const r = await tx.query(
          `UPDATE users SET codes_secours_hash = array_remove(codes_secours_hash, $2)
            WHERE id = $1 AND $2 = ANY(codes_secours_hash)`,
          [user.id, empreinte],
        );
        return (r.rowCount ?? 0) > 0;
      }, ctx);
    }
    if (!accepte) {
      await this.enregistrerEchec(user.id, 'totp', claims.can);
      throw new ErreurMetier('TOTP_INVALIDE', 'Code incorrect');
    }
    const acces = await this.mesAcces(user.id);
    return this.ouvrirSession(user, claims.can, acces, p.userAgent, 'totp');
  }

  // ---------------------------------------------------------------------------
  // Activation TOTP (RF-003)
  // ---------------------------------------------------------------------------

  async demarrerActivationTotp(auth: AuthRequete): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = genererSecretTotp();
    const compte = await this.db.tx(async (tx) => {
      const r = await tx.query<{ telephone: string; totp_actif: boolean }>(
        `SELECT telephone, totp_actif FROM users WHERE id = $1 FOR UPDATE`,
        [auth.userId],
      );
      const u = r.rows[0];
      if (!u) throw new ErreurMetier('NON_AUTHENTIFIE', 'Compte introuvable');
      if (u.totp_actif) throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Le TOTP est déjà actif sur ce compte');
      await tx.query(`UPDATE users SET totp_secret_chiffre = $2 WHERE id = $1`, [
        auth.userId,
        chiffrer(secret, this.secrets.cleChiffrement),
      ]);
      return u.telephone;
    }, auth.contexte);
    return { secret: encoderBase32(secret), otpauthUrl: urlOtpauth(secret, compte) };
  }

  /**
   * Confirme l'activation et renvoie les 10 codes de secours (affichés une seule fois).
   * Avec le jeton intermédiaire `totp_activation`, termine aussi la connexion (session dans la réponse).
   */
  async confirmerTotp(
    auth: AuthRequete,
    code: string,
    userAgent?: string,
  ): Promise<{ codesSecours: string[]; session?: SessionEmise }> {
    const user = await this.db.tx((tx) => this.chargerUser(tx, auth.userId), auth.contexte);
    if (!user) throw new ErreurMetier('NON_AUTHENTIFIE', 'Compte introuvable');
    if (user.totp_actif) throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Le TOTP est déjà actif sur ce compte');
    if (!user.totp_secret_chiffre)
      throw new ErreurMetier('ETAT_INCOMPATIBLE', "Démarrez d'abord l'activation du TOTP");
    const secret = dechiffrer(user.totp_secret_chiffre, this.secrets.cleChiffrement);
    const pas = verifierTotp(secret, code);
    if (pas === null) {
      throw new ErreurMetier('VALIDATION', 'Code TOTP incorrect', [
        {
          champ: 'code',
          code: 'TOTP_INVALIDE',
          message: 'Code incorrect : vérifiez l’heure de votre téléphone.',
        },
      ]);
    }
    const codesSecours = genererCodesSecours();
    await this.db.tx(async (tx) => {
      await tx.query(
        `UPDATE users SET totp_actif = true, totp_dernier_pas = $2, codes_secours_hash = $3 WHERE id = $1`,
        [user.id, pas, codesSecours.map((c) => hmacPoivre(c, this.secrets.poivreOtp))],
      );
      await this.audit.tracer(tx, {
        associationId: null,
        acteurId: user.id,
        action: 'utilisateur.totp_active',
        entiteType: 'utilisateur',
        entiteId: user.id,
      });
    }, auth.contexte);
    if (auth.type !== 'intermediaire') return { codesSecours };
    const acces = await this.mesAcces(user.id);
    return { codesSecours, session: await this.ouvrirSession(user, auth.canal, acces, userAgent, 'totp') };
  }

  // ---------------------------------------------------------------------------
  // Refresh, déconnexion, profil, contexte
  // ---------------------------------------------------------------------------

  async rafraichir(refreshToken: string, canalTransport: Canal, userAgent?: string): Promise<SessionEmise> {
    const ctx = this.ctx();
    const r = await this.db.tx(
      (tx) => this.sessions.tourner(tx, refreshToken, canalTransport, ctx.ip, userAgent),
      ctx,
    );
    switch (r.statut) {
      case 'ok':
        break;
      case 'canal':
        throw new ErreurMetier('NON_AUTHENTIFIE', 'Refresh token présenté sur le mauvais canal');
      case 'reutilisation':
        throw new ErreurMetier(
          'SESSION_REVOQUEE',
          'Session révoquée (refresh token réutilisé) : reconnectez-vous',
        );
      case 'expiree':
        throw new ErreurMetier('SESSION_REVOQUEE', 'Session expirée : reconnectez-vous');
      default:
        throw new ErreurMetier('SESSION_REVOQUEE', 'Session révoquée : reconnectez-vous');
    }
    const user = await this.db.tx((tx) => this.chargerUser(tx, r.userId), { ...ctx, userId: r.userId });
    const acces = await this.mesAcces(r.userId);
    // La session liée à un appareil (sprint 5) garde la claim `dev` au refresh.
    return this.emettre(
      user!,
      canalTransport,
      r.session,
      r.associationId ?? undefined,
      acces,
      r.appareilId ?? undefined,
    );
  }

  async deconnecter(auth: AuthRequete): Promise<void> {
    if (!auth.sessionId) return;
    await this.db.tx((tx) => this.sessions.revoquerParSession(tx, auth.sessionId!), auth.contexte);
  }

  async moi(userId: string): Promise<UtilisateurMoi> {
    const user = await this.db.tx((tx) => this.chargerUser(tx, userId), { ...this.ctx(), userId });
    if (!user) throw new ErreurMetier('NON_AUTHENTIFIE', 'Compte introuvable');
    return this.versMoi(user, await this.mesAcces(userId));
  }

  /** Choix de l'association active (E1-07) : refus si aucun accès actif au mandat en cours. */
  async choisirContexte(auth: AuthRequete, associationId: string): Promise<SessionEmise> {
    if (auth.rolePlateforme) {
      throw new ErreurMetier('PERMISSION_REFUSEE', "L'espace plateforme n'a pas d'association active");
    }
    const acces = await this.mesAcces(auth.userId);
    const cible = acces.find((a) => a.association_id === associationId && a.en_cours);
    if (!cible) throw new ErreurMetier('ACCES_REVOQUE', "Vous n'avez pas d'accès actif à cette association");
    const ctxTenant: ContexteRequete = {
      ...auth.contexte,
      associationId,
      userId: auth.userId,
      rolePlateforme: undefined,
    };
    const user = await this.db.tx(async (tx) => {
      await this.sessions.definirAssociation(tx, auth.sessionId!, associationId);
      await this.audit.tracer(tx, {
        associationId,
        acteurId: auth.userId,
        action: 'session.contexte_choisi',
        entiteType: 'session',
        entiteId: auth.sessionId!,
        apres: { canal: auth.canal, role: cible.role_code },
      });
      return this.chargerUser(tx, auth.userId);
    }, ctxTenant);
    const { jeton, expireDans } = await this.jetons.signerAcces({
      sub: auth.userId,
      sid: auth.sessionId!,
      aid: associationId,
      can: auth.canal,
      dev: auth.appareilId,
    });
    return { accessToken: jeton, expireDans, canal: auth.canal, utilisateur: this.versMoi(user!, acces) };
  }

  // ---------------------------------------------------------------------------
  // Interne
  // ---------------------------------------------------------------------------

  private async ouvrirSession(
    user: LigneUser,
    canal: Canal,
    acces: LigneMesAcces[],
    userAgent: string | undefined,
    methode: 'mot_de_passe' | 'totp',
  ): Promise<SessionEmise> {
    const ctx = { ...this.ctx(), userId: user.id };
    // Association active d'office si l'utilisateur n'en a qu'une (sélecteur sinon, docs/08 A0).
    const enCours = acces.filter((a) => a.en_cours);
    const aid = !user.role_plateforme && enCours.length === 1 ? enCours[0]!.association_id : undefined;
    const session = await this.db.tx(async (tx) => {
      await tx.query(`UPDATE users SET echecs_connexion = 0, derniere_connexion = now() WHERE id = $1`, [
        user.id,
      ]);
      const s = await this.sessions.creer(tx, {
        userId: user.id,
        canal,
        associationId: aid ?? null,
        ip: ctx.ip,
        userAgent,
      });
      await this.audit.tracer(tx, {
        associationId: null,
        acteurId: user.id,
        action: 'connexion.reussie',
        entiteType: 'session',
        entiteId: s.sessionId,
        apres: { canal, methode },
      });
      return s;
    }, ctx);
    return this.emettre(user, canal, session, aid, acces);
  }

  private async emettre(
    user: LigneUser,
    canal: Canal,
    session: NouvelleSession,
    aid: string | undefined,
    acces: LigneMesAcces[],
    appareilId?: string,
  ): Promise<SessionEmise> {
    const { jeton, expireDans } = await this.jetons.signerAcces({
      sub: user.id,
      sid: session.sessionId,
      aid,
      can: canal,
      dev: appareilId,
      pf: user.role_plateforme ?? undefined,
    });
    return {
      accessToken: jeton,
      expireDans,
      refreshToken: session.refreshToken,
      refreshExpireAt: session.expireAt,
      canal,
      utilisateur: this.versMoi(user, acces),
    };
  }

  private versMoi(user: LigneUser, acces: LigneMesAcces[]): UtilisateurMoi {
    return {
      id: user.id,
      telephone: user.telephone,
      email: user.email,
      nom: user.nom,
      prenoms: user.prenoms,
      totpActif: user.totp_actif,
      rolePlateforme: user.role_plateforme,
      acces: acces
        .filter((a) => a.en_cours)
        .map((a) => ({
          associationId: a.association_id,
          associationNom: a.association_nom,
          role: { code: a.role_code, libelle: a.role_libelle },
          permissions: a.permissions,
        })),
    };
  }

  /** Accès actifs de l'utilisateur, tous tenants (fonction SECURITY DEFINER limitée à app_user_id()). */
  private async mesAcces(userId: string): Promise<LigneMesAcces[]> {
    return this.db.tx(async (tx) => (await tx.query<LigneMesAcces>(`SELECT * FROM app_mes_acces()`)).rows, {
      ...this.ctx(),
      userId,
      associationId: undefined,
    });
  }

  private async chargerUser(tx: Tx, id: string): Promise<LigneUser | null> {
    const r = await tx.query<LigneUser>(`SELECT ${COLONNES_USER} FROM users WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  private async trouverParIdentifiant(tx: Tx, identifiant: string): Promise<LigneUser | null> {
    let telephone: string | null = null;
    if (!identifiant.includes('@')) {
      try {
        telephone = normaliserTelephone(identifiant);
      } catch {
        return null;
      }
    }
    const r = telephone
      ? await tx.query<LigneUser>(`SELECT ${COLONNES_USER} FROM users WHERE telephone = $1`, [telephone])
      : await tx.query<LigneUser>(`SELECT ${COLONNES_USER} FROM users WHERE email = $1`, [identifiant]);
    return r.rows[0] ?? null;
  }

  private refuserSiVerrouille(user: LigneUser): void {
    if (user.verrouille_jusqua && user.verrouille_jusqua.getTime() > Date.now()) {
      throw this.compteVerrouille(user.verrouille_jusqua);
    }
  }

  private compteVerrouille(jusqua: Date): ErreurMetier {
    const secondes = Math.max(1, Math.ceil((jusqua.getTime() - Date.now()) / 1000));
    const minutes = Math.ceil(secondes / 60);
    return new ErreurMetier(
      'COMPTE_VERROUILLE',
      `Compte verrouillé après plusieurs échecs. Réessayez dans ${minutes} min.`,
      [],
      { 'retry-after': String(secondes) },
    );
  }

  private identifiantsInvalides(): ErreurMetier {
    return new ErreurMetier('IDENTIFIANTS_INVALIDES', 'Identifiant ou mot de passe incorrect');
  }

  /**
   * RF-005 : compte l'échec ; au 5e échec consécutif, verrouille 15 min (doublé à chaque verrouillage
   * dans les 24 h, max 24 h) et lève 423. Le compteur est engagé avant que l'erreur ne remonte.
   */
  private async enregistrerEchec(
    userId: string,
    motif: 'mot_de_passe' | 'totp',
    canal: Canal,
  ): Promise<void> {
    const ctx = { ...this.ctx(), userId };
    const verrou = await this.db.tx(async (tx) => {
      const r = await tx.query<{
        echecs_connexion: number;
        verrouillages_recents: number;
        dernier_verrouillage: Date | null;
      }>(
        `UPDATE users SET echecs_connexion = echecs_connexion + 1 WHERE id = $1
         RETURNING echecs_connexion, verrouillages_recents, dernier_verrouillage`,
        [userId],
      );
      const u = r.rows[0]!;
      await this.audit.tracer(tx, {
        associationId: null,
        acteurId: userId,
        action: 'connexion.echouee',
        entiteType: 'utilisateur',
        entiteId: userId,
        apres: { motif, canal, echecs: u.echecs_connexion },
      });
      if (u.echecs_connexion < ECHECS_AVANT_VERROUILLAGE) return null;
      const v = calculerVerrouillage(new Date(), {
        nombre: u.verrouillages_recents,
        dernier: u.dernier_verrouillage,
      });
      await tx.query(
        `UPDATE users SET echecs_connexion = 0, verrouille_jusqua = $2, verrouillages_recents = $3,
                          dernier_verrouillage = now() WHERE id = $1`,
        [userId, v.jusqua, v.nombre],
      );
      await this.audit.tracer(tx, {
        associationId: null,
        acteurId: userId,
        action: 'utilisateur.verrouille',
        entiteType: 'utilisateur',
        entiteId: userId,
        apres: { jusqua: v.jusqua.toISOString(), verrouillagesRecents: v.nombre },
      });
      return v.jusqua;
    }, ctx);
    if (verrou) throw this.compteVerrouille(verrou);
  }

  private async tracerEchec(userId: string | null, motif: string, canal: Canal): Promise<void> {
    await this.db.tx(
      (tx) =>
        this.audit.tracer(tx, {
          associationId: null,
          acteurId: userId,
          action: 'connexion.echouee',
          entiteType: 'utilisateur',
          entiteId: userId,
          apres: { motif, canal },
        }),
      this.ctx(),
    );
  }

  private hmacOtp(telephone: string, but: string, code: string): string {
    return hmacPoivre(`${telephone}|${but}|${code}`, this.secrets.poivreOtp);
  }

  private hashFactice(): Promise<string> {
    hashFactice ??= hacherMotDePasse('mot-de-passe-factice-assoflow');
    return hashFactice;
  }

  private ctx(): ContexteRequete {
    const c = contexteCourant();
    return { requestId: c?.requestId ?? 'interne', ip: c?.ip };
  }
}

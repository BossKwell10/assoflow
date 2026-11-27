import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DUREE_URL_ECRITURE_S,
  DUREE_URL_LECTURE_S,
  verifierCle,
  type StockageObjets,
} from './stockage-objets.js';

const TYPES_PAR_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Stockage sur disque (développement et tests, jamais en production). Les fichiers sont servis par l'API
 * (`GET /v1/fichiers?c=…`) avec une URL signée HMAC valable 5 minutes, comme une URL présignée S3.
 */
export class StockageLocal implements StockageObjets {
  private readonly cleSignature = randomBytes(32);

  constructor(
    private readonly dossier: string,
    private readonly baseUrl: string,
  ) {}

  private chemin(cle: string): string {
    return path.join(this.dossier, ...verifierCle(cle).split('/'));
  }

  async deposer(cle: string, contenu: Buffer): Promise<void> {
    const cible = this.chemin(cle);
    await mkdir(path.dirname(cible), { recursive: true });
    await writeFile(cible, contenu);
  }

  async supprimer(cle: string): Promise<void> {
    await rm(this.chemin(cle), { force: true });
  }

  async contenu(cle: string): Promise<Buffer | null> {
    try {
      return await readFile(this.chemin(cle));
    } catch {
      return null;
    }
  }

  async urlLecture(cle: string, maintenant = Date.now()): Promise<string> {
    const exp = Math.floor(maintenant / 1000) + DUREE_URL_LECTURE_S;
    const jeton = Buffer.from(verifierCle(cle)).toString('base64url');
    return `${this.baseUrl.replace(/\/$/, '')}/v1/fichiers?c=${jeton}&exp=${exp}&sig=${this.signer(cle, exp)}`;
  }

  /** Envoi direct au stockage local (`PUT /v1/fichiers?…`), signé comme une URL présignée S3. */
  async urlEcriture(cle: string, typeMime: string, maintenant = Date.now()) {
    const exp = Math.floor(maintenant / 1000) + DUREE_URL_ECRITURE_S;
    const jeton = Buffer.from(verifierCle(cle)).toString('base64url');
    const sig = this.signer(`ecriture|${cle}|${typeMime}`, exp);
    return {
      url: `${this.baseUrl.replace(/\/$/, '')}/v1/fichiers?c=${jeton}&exp=${exp}&sig=${sig}`,
      entetes: { 'content-type': typeMime },
    };
  }

  /** Écrit un fichier envoyé par `PUT` si la signature (clé, type, échéance) est valide ; `false` sinon. */
  async ecrire(
    jeton: string | undefined,
    exp: string | undefined,
    sig: string | undefined,
    typeMime: string | undefined,
    contenu: Buffer,
  ): Promise<boolean> {
    let cle: string;
    if (!jeton || !typeMime) return false;
    try {
      cle = verifierCle(Buffer.from(jeton, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    const expiration = Number(exp);
    if (!sig || !Number.isInteger(expiration) || expiration < Date.now() / 1000) return false;
    const attendu = Buffer.from(this.signer(`ecriture|${cle}|${typeMime}`, expiration));
    const recu = Buffer.from(sig);
    if (attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) return false;
    await this.deposer(cle, contenu);
    return true;
  }

  /** Lit un fichier si la signature est valide et non expirée ; `null` sinon (→ 404). */
  async lire(
    jeton: string | undefined,
    exp: string | undefined,
    sig: string | undefined,
  ): Promise<{ contenu: Buffer; type: string } | null> {
    let cle: string;
    if (!jeton) return null;
    try {
      cle = verifierCle(Buffer.from(jeton, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const expiration = Number(exp);
    if (!sig || !Number.isInteger(expiration) || expiration < Date.now() / 1000) return null;
    const attendu = Buffer.from(this.signer(cle, expiration));
    const recu = Buffer.from(sig);
    if (attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) return null;
    try {
      const contenu = await readFile(this.chemin(cle));
      const ext = cle.split('.').pop() ?? '';
      return { contenu, type: TYPES_PAR_EXTENSION[ext] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  private signer(cle: string, exp: number): string {
    return createHmac('sha256', this.cleSignature).update(`${cle}|${exp}`).digest('base64url');
  }
}

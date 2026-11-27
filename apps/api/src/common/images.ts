import type { FastifyRequest } from 'fastify';
import { ErreurMetier } from './erreur-metier.js';

/** Fichiers multipart acceptés par l'API (docs/07 §6) : logo, photo de membre, 2 Mo maximum. */
export const TAILLE_MAX_IMAGE = 2 * 1024 * 1024;

export interface Image {
  contenu: Buffer;
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
}

/**
 * Type réel d'une image d'après ses premiers octets (*magic bytes*, docs/04 §8) ; le type MIME et
 * l'extension déclarés par le client ne sont jamais crus.
 */
export function detecterTypeImage(b: Buffer): Omit<Image, 'contenu'> | null {
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { type: 'image/png', extension: 'png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: 'image/jpeg', extension: 'jpg' };
  }
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return { type: 'image/webp', extension: 'webp' };
  }
  return null;
}

function invalide(code: string, message: string): ErreurMetier {
  return new ErreurMetier('VALIDATION', message, [{ champ: 'fichier', code, message }]);
}

/** Lit la partie `fichier` d'une requête multipart (2 Mo au plus), sans contrôle de type. */
export async function lireFichierMultipart(req: FastifyRequest): Promise<{ contenu: Buffer; nom: string }> {
  if (!req.isMultipart()) throw invalide('MULTIPART_ATTENDU', 'Requête multipart/form-data attendue');
  try {
    const partie = await req.file();
    if (!partie || partie.fieldname !== 'fichier') {
      throw invalide('FICHIER_MANQUANT', 'Champ « fichier » manquant');
    }
    const contenu = await partie.toBuffer();
    if (contenu.length === 0) throw invalide('FICHIER_MANQUANT', 'Fichier vide');
    return { contenu, nom: partie.filename.slice(0, 200) };
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw invalide('FICHIER_TROP_GROS', 'Fichier trop volumineux (2 Mo maximum)');
    }
    throw invalide('MULTIPART_INVALIDE', 'Corps multipart illisible');
  }
}

/** Lit la partie `fichier` d'une requête multipart et vérifie taille et type réel (PNG, JPEG, WebP). */
export async function lireImageMultipart(req: FastifyRequest): Promise<Image> {
  if (!req.isMultipart()) throw invalide('MULTIPART_ATTENDU', 'Requête multipart/form-data attendue');
  let contenu: Buffer;
  try {
    const partie = await req.file();
    if (!partie || partie.fieldname !== 'fichier') {
      throw invalide('FICHIER_MANQUANT', 'Champ « fichier » manquant');
    }
    contenu = await partie.toBuffer();
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw invalide('FICHIER_TROP_GROS', 'Fichier trop volumineux (2 Mo maximum)');
    }
    throw invalide('MULTIPART_INVALIDE', 'Corps multipart illisible');
  }
  if (contenu.length === 0) throw invalide('FICHIER_MANQUANT', 'Fichier vide');
  const type = detecterTypeImage(contenu);
  if (!type) throw invalide('TYPE_FICHIER_INVALIDE', 'Image PNG, JPEG ou WebP attendue');
  return { contenu, ...type };
}

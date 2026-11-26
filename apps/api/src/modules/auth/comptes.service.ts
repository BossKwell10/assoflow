import { Injectable } from '@nestjs/common';
import { VERSION_CGU } from '@assoflow/contracts';
import type { Tx } from '../../infra/database.js';
import { hacherMotDePasse } from './domain/argon2.js';

/** Résumé d'un compte utilisateur exposé aux autres modules (jamais de hash ni de secret). */
export interface ResumeCompte {
  id: string;
  telephone: string;
  nom: string;
  prenoms: string;
  derniereConnexion: Date | null;
  verrouille: boolean;
}

/**
 * Interface publique du module auth sur la table `users` (docs/02 §3.1 : seul le module auth y accède).
 * Utilisée par les modules utilisateurs (invitation, déverrouillage) et associations (président).
 */
@Injectable()
export class ComptesService {
  /** Trouve le compte par téléphone (clé, E.164) ou le crée sans mot de passe (invitation, docs/04 §2.1). */
  async trouverOuCreer(
    tx: Tx,
    p: { telephone: string; nom: string; prenoms: string },
  ): Promise<{ id: string; cree: boolean }> {
    const r = await tx.query<{ id: string; cree: boolean }>(
      `WITH ins AS (
         INSERT INTO users (telephone, nom, prenoms) VALUES ($1, $2, $3)
         ON CONFLICT (telephone) DO NOTHING RETURNING id)
       SELECT id, true AS cree FROM ins
       UNION ALL
       SELECT id, false AS cree FROM users WHERE telephone = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
      [p.telephone, p.nom, p.prenoms],
    );
    return r.rows[0]!;
  }

  async resumes(tx: Tx, ids: readonly string[]): Promise<Map<string, ResumeCompte>> {
    if (ids.length === 0) return new Map();
    const r = await tx.query<{
      id: string;
      telephone: string;
      nom: string;
      prenoms: string;
      derniere_connexion: Date | null;
      verrouille: boolean;
    }>(
      `SELECT id, telephone, nom, prenoms, derniere_connexion,
              coalesce(verrouille_jusqua > now(), false) AS verrouille
         FROM users WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(
      r.rows.map((u) => [
        u.id,
        {
          id: u.id,
          telephone: u.telephone,
          nom: u.nom,
          prenoms: u.prenoms,
          derniereConnexion: u.derniere_connexion,
          verrouille: u.verrouille,
        },
      ]),
    );
  }

  /** Déverrouillage par un administrateur (RF-005, RF-SUP-011) : remet aussi le compteur d'échecs à zéro. */
  async deverrouiller(tx: Tx, userId: string): Promise<{ etaitVerrouille: boolean }> {
    const r = await tx.query<{ etait: boolean }>(
      `UPDATE users u SET verrouille_jusqua = NULL, echecs_connexion = 0
         FROM (SELECT id, coalesce(verrouille_jusqua > now(), false) AS etait FROM users WHERE id = $1 FOR UPDATE) v
        WHERE u.id = v.id RETURNING v.etait`,
      [userId],
    );
    return { etaitVerrouille: r.rows[0]?.etait ?? false };
  }

  /**
   * Données de démonstration uniquement (`seed:demo`, jamais en production) : définit un mot de passe
   * et enregistre les consentements comme le ferait le parcours OTP.
   */
  async initialiserPourDemo(tx: Tx, userId: string, motDePasse: string): Promise<void> {
    await tx.query(`UPDATE users SET mot_de_passe_hash = $2 WHERE id = $1`, [
      userId,
      await hacherMotDePasse(motDePasse),
    ]);
    for (const type of ['cgu', 'traitement_donnees']) {
      await tx.query(
        `INSERT INTO consentements (user_id, type, version_texte, accorde, recueilli_par, canal)
         SELECT $1, $2, $3, true, $1, 'console'
          WHERE NOT EXISTS (SELECT 1 FROM consentements WHERE user_id = $1 AND type = $2 AND version_texte = $3)`,
        [userId, type, VERSION_CGU],
      );
    }
  }
}

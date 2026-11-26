import type { Canal } from '@assoflow/contracts';
import type { ContexteRequete } from '../contexte.js';

/** Identité authentifiée d'une requête, posée par `AuthGuard` sur `request.auth`. */
export interface AuthRequete {
  type: 'acces' | 'intermediaire';
  userId: string;
  canal: Canal;
  sessionId?: string;
  associationId?: string;
  appareilId?: string;
  rolePlateforme?: 'super_admin' | 'support';
  /** Permissions effectives dans le tenant actif (rôle + délégations), ou plateforme. */
  permissions: readonly string[];
  /** Contexte posé pour la durée du traitement (RLS). */
  contexte: ContexteRequete;
}

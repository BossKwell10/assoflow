import { AsyncLocalStorage } from 'node:async_hooks';

/** Contexte d'une requête ou d'un job, posé par le guard d'authentification ou le worker. */
export interface ContexteRequete {
  requestId: string;
  associationId?: string;
  userId?: string;
  rolePlateforme?: 'super_admin' | 'support';
  /** Adresse IP du client (audit). */
  ip?: string;
}

export const contexteStorage = new AsyncLocalStorage<ContexteRequete>();

export function contexteCourant(): ContexteRequete | undefined {
  return contexteStorage.getStore();
}

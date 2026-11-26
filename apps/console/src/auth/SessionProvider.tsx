import type { Permission } from '@assoflow/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { rafraichirSession } from '../api/client';
import { ecouterSession, ouvrirSession, perdreSession } from '../api/jeton';
import {
  getGetAuthMoiQueryKey,
  postAuthContexte,
  postAuthDeconnexion,
  useGetAuthMoi,
} from '../api/generated/authentification/authentification';
import type { AccesResume, UtilisateurMoi } from '../api/generated/modeles';
import {
  abonnerEtatSession,
  annoncerMotifDeconnexion,
  definirAssociationActive,
  lireEtatSession,
  marquerDeconnecte,
  type EtatSession,
  type MotifDeconnexion,
} from './etat';

export interface ContexteSession {
  statut: EtatSession['statut'];
  motif?: MotifDeconnexion;
  utilisateur?: UtilisateurMoi;
  associationActive?: AccesResume;
  permissions: ReadonlySet<string>;
  choisirAssociation: (associationId: string) => Promise<void>;
  deconnecter: (motif?: MotifDeconnexion) => Promise<void>;
}

const Contexte = createContext<ContexteSession | undefined>(undefined);

/**
 * Session de la console : reprise par refresh au chargement, utilisateur (`GET /auth/moi`),
 * association active et permissions de cette association (docs/08 §3).
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const etat = useSyncExternalStore(abonnerEtatSession, lireEtatSession, lireEtatSession);

  useEffect(
    () =>
      ecouterSession((evenement) => {
        if (evenement.type === 'ouverte') {
          client.setQueryData(getGetAuthMoiQueryKey(), evenement.session.utilisateur);
        } else {
          client.clear();
        }
      }),
    [client],
  );

  // Reprise de session : le cookie HttpOnly de refresh permet de retrouver un access token après rechargement.
  useEffect(() => {
    if (lireEtatSession().statut !== 'inconnu') return;
    void rafraichirSession().then((ok) => {
      if (!ok && lireEtatSession().statut === 'inconnu') marquerDeconnecte();
    });
  }, []);

  const moi = useGetAuthMoi({
    query: { enabled: etat.statut === 'connecte', initialData: etat.utilisateur, staleTime: 60_000 },
  });
  const utilisateur = etat.statut === 'connecte' ? (moi.data ?? etat.utilisateur) : undefined;
  const associationActive = utilisateur?.acces.find((a) => a.associationId === etat.associationActiveId);

  const choisirAssociation = useCallback(
    async (associationId: string) => {
      const session = await postAuthContexte({ associationId });
      // Les données de l'association précédente ne doivent pas survivre au changement de contexte.
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== getGetAuthMoiQueryKey()[0] });
      ouvrirSession(session);
      if (lireEtatSession().associationActiveId !== associationId) definirAssociationActive(associationId);
    },
    [client],
  );

  const deconnecter = useCallback(async (motif: MotifDeconnexion = 'volontaire') => {
    annoncerMotifDeconnexion(motif);
    try {
      await postAuthDeconnexion();
    } catch {
      // La session est fermée côté console quoi qu'il arrive.
    }
    if (lireEtatSession().statut !== 'deconnecte') perdreSession();
  }, []);

  const valeur = useMemo<ContexteSession>(
    () => ({
      statut: etat.statut,
      motif: etat.motif,
      utilisateur,
      associationActive,
      permissions: new Set(associationActive?.permissions ?? []),
      choisirAssociation,
      deconnecter,
    }),
    [etat.statut, etat.motif, utilisateur, associationActive, choisirAssociation, deconnecter],
  );

  return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

export function useSession(): ContexteSession {
  const valeur = useContext(Contexte);
  if (!valeur) throw new Error('useSession doit être utilisé sous <SessionProvider>');
  return valeur;
}

/** Vrai si l'utilisateur a la permission dans l'association active. */
export function usePermission(code: Permission): boolean {
  return useSession().permissions.has(code);
}

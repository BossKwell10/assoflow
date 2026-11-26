import { Center, Loader } from '@mantine/core';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { useSession } from './SessionProvider';
import { SurveillanceInactivite } from './SurveillanceInactivite';

type Cible = '/connexion' | '/choix-association';

/**
 * Redirection unique (effet) : un <Navigate> rendu à chaque passage relancerait la navigation
 * pendant le chargement à la demande de l'écran cible.
 */
function Rediriger({ vers, avecRetour }: { vers: Cible; avecRetour?: boolean }) {
  const naviguer = useNavigate();
  const chemin = useRouterState({ select: (s) => s.location.href });
  // Figé au premier rendu : pendant la navigation, l'emplacement courant devient déjà la cible.
  const [retour] = useState(() =>
    avecRetour && chemin !== '/' && !chemin.startsWith(vers) ? chemin : undefined,
  );
  useEffect(() => {
    void naviguer({ to: vers, search: retour ? { redirect: retour } : {}, replace: true });
  }, [naviguer, vers, retour]);
  return <Chargement />;
}

function Chargement() {
  return (
    <Center mih="100vh">
      <Loader aria-label={t('commun.chargement')} />
    </Center>
  );
}

/** Exige une session ouverte ; sinon redirige vers /connexion en mémorisant la page demandée. */
export function ExigerSession({ children }: { children: ReactNode }) {
  const { statut } = useSession();
  if (statut === 'inconnu') return <Chargement />;
  if (statut === 'deconnecte') return <Rediriger vers="/connexion" avecRetour />;
  return (
    <>
      <SurveillanceInactivite />
      {children}
    </>
  );
}

/**
 * Garde de l'espace association : session ouverte, puis association active choisie.
 * Le TOTP est garanti par l'API : aucune session console n'est émise pour le bureau sans second facteur.
 */
export function ExigerEspaceAssociation({ children }: { children: ReactNode }) {
  return (
    <ExigerSession>
      <ExigerContexte>{children}</ExigerContexte>
    </ExigerSession>
  );
}

function ExigerContexte({ children }: { children: ReactNode }) {
  const { utilisateur, associationActive } = useSession();
  if (!utilisateur) return <Chargement />;
  if (!associationActive) return <Rediriger vers="/choix-association" avecRetour />;
  return children;
}

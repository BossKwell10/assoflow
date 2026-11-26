import { Button, Group, Modal, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { rafraichirSession } from '../api/client';
import { t } from '../i18n';
import { useSession } from './SessionProvider';

/** RF-006 : déconnexion après 30 min d'inactivité, avertissement 2 min avant (docs/04 §3, docs/08 §3). */
export const DELAI_DECONNEXION_MS = 30 * 60_000;
export const DELAI_AVERTISSEMENT_MS = 28 * 60_000;
const EVENEMENTS_ACTIVITE = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
] as const;
/** Évite de réarmer les minuteries à chaque mouvement de souris. */
const INTERVALLE_MIN_MS = 1_000;

export function SurveillanceInactivite() {
  const { deconnecter } = useSession();
  const [avertissement, setAvertissement] = useState(false);
  const avertissementRef = useRef(false);
  const minuteries = useRef<ReturnType<typeof setTimeout>[]>([]);
  const armerRef = useRef<() => void>(() => {});

  useEffect(() => {
    let derniere = 0;
    const vider = () => {
      minuteries.current.forEach(clearTimeout);
      minuteries.current = [];
    };
    const armer = () => {
      vider();
      derniere = Date.now();
      minuteries.current = [
        setTimeout(() => {
          avertissementRef.current = true;
          setAvertissement(true);
        }, DELAI_AVERTISSEMENT_MS),
        setTimeout(() => void deconnecter('inactivite'), DELAI_DECONNEXION_MS),
      ];
    };
    armerRef.current = armer;
    const surActivite = () => {
      // Pendant l'avertissement, seule une action explicite prolonge la session.
      if (avertissementRef.current || Date.now() - derniere < INTERVALLE_MIN_MS) return;
      armer();
    };
    armer();
    for (const e of EVENEMENTS_ACTIVITE) window.addEventListener(e, surActivite, { passive: true });
    return () => {
      vider();
      for (const e of EVENEMENTS_ACTIVITE) window.removeEventListener(e, surActivite);
    };
  }, [deconnecter]);

  const rester = () => {
    avertissementRef.current = false;
    setAvertissement(false);
    armerRef.current();
    void rafraichirSession();
  };

  return (
    <Modal
      opened={avertissement}
      onClose={rester}
      title={t('inactivite.titre')}
      centered
      closeOnClickOutside={false}
    >
      <Text mb="lg">{t('inactivite.message')}</Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => void deconnecter('volontaire')}>
          {t('inactivite.deconnecter')}
        </Button>
        <Button onClick={rester} data-autofocus>
          {t('inactivite.rester')}
        </Button>
      </Group>
    </Modal>
  );
}

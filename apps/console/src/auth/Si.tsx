import type { Permission } from '@assoflow/contracts';
import type { ReactNode } from 'react';
import { useSession } from './SessionProvider';

/** Vrai si au moins une des permissions est accordée dans l'association active. */
export function useAuMoinsUnePermission(permissions: Permission | readonly Permission[]): boolean {
  const { permissions: accordees } = useSession();
  const liste = typeof permissions === 'string' ? [permissions] : permissions;
  return liste.some((p) => accordees.has(p));
}

/**
 * Rendu conditionnel par permission (docs/08 §7) : un élément non autorisé est masqué.
 * Avec une liste, une seule permission suffit.
 */
export function Si({
  permission,
  sinon = null,
  children,
}: {
  permission: Permission | readonly Permission[];
  sinon?: ReactNode;
  children: ReactNode;
}) {
  return useAuMoinsUnePermission(permission) ? children : sinon;
}

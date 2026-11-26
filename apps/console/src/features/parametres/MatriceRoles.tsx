import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import { useGetPermissions, useGetRoles } from '../../api/generated/acces-et-roles/acces-et-roles';
import { t } from '../../i18n';
import { messageErreur } from '../../shared/erreurs';

/** Onglet Rôles de A30 : matrice permissions × rôles, en lecture au sprint 1 (RF-ADM-012). */
export function MatriceRoles() {
  const roles = useGetRoles();
  const permissions = useGetPermissions();

  if (roles.isPending || permissions.isPending) {
    return (
      <Group justify="center" p="xl">
        <Loader aria-label={t('commun.chargement')} />
      </Group>
    );
  }
  if (roles.isError || permissions.isError) {
    return (
      <Alert color="red" role="alert">
        {messageErreur(roles.error ?? permissions.error)}
      </Alert>
    );
  }

  const parModule = new Map<string, typeof permissions.data>();
  for (const p of permissions.data) {
    const module = p.module ?? p.code?.split('.')[0] ?? '';
    parModule.set(module, [...(parModule.get(module) ?? []), p]);
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('utilisateurs.matriceIntro')}
      </Text>
      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        <ScrollArea>
          <Table striped withColumnBorders stickyHeader miw={720}>
            <caption>
              <VisuallyHidden>{t('utilisateurs.matriceTitre')}</VisuallyHidden>
            </caption>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('utilisateurs.colPermission')}</Table.Th>
                {roles.data.map((r) => (
                  <Table.Th key={r.id ?? r.code} scope="col" ta="center">
                    {r.libelle}
                    {r.systeme && (
                      <Text size="xs" c="dimmed" fw={400}>
                        {t('utilisateurs.roleSysteme')}
                      </Text>
                    )}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[...parModule.entries()].map(([module, liste]) => [
                <Table.Tr key={`module-${module}`}>
                  <Table.Th colSpan={roles.data.length + 1} scope="colgroup" bg="#F6F7F9" tt="capitalize">
                    {module}
                  </Table.Th>
                </Table.Tr>,
                ...liste.map((p) => (
                  <Table.Tr key={p.code}>
                    <Table.Th scope="row" fw={400}>
                      <Text size="sm">{p.libelle ?? p.code}</Text>
                      <Group gap={6}>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {p.code}
                        </Text>
                        {p.reserveePresident && (
                          <Badge size="xs" variant="light" color="gray" tt="none">
                            {t('utilisateurs.reservePresident')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Th>
                    {roles.data.map((r) => {
                      const accorde = !!p.code && r.permissions.includes(p.code);
                      return (
                        <Table.Td key={r.id ?? r.code} ta="center">
                          <span aria-hidden style={{ color: accorde ? '#0E7C6B' : '#9AA1AC' }}>
                            {accorde ? '✓' : '—'}
                          </span>
                          <VisuallyHidden>{accorde ? t('commun.oui') : t('commun.non')}</VisuallyHidden>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                )),
              ])}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Card>
    </Stack>
  );
}

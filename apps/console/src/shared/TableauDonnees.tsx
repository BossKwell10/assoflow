import {
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { messageErreur } from './erreurs';

export interface Colonne<T> {
  cle: string;
  titre: string;
  rendu: (ligne: T) => ReactNode;
  /** Valeurs de `?tri=` admises par l'endpoint (liste blanche) pour l'ordre croissant et décroissant. */
  tri?: { asc?: string; desc?: string };
}

/** Prochain tri au clic sur un en-tête : croissant, puis décroissant si disponible. */
function triSuivant(tri: Colonne<unknown>['tri'], actuel?: string): string | undefined {
  if (!tri) return undefined;
  if (actuel === tri.asc && tri.desc) return tri.desc;
  if (actuel === tri.desc && tri.asc) return tri.asc;
  return tri.asc ?? tri.desc;
}

function sensTri(tri: Colonne<unknown>['tri'], actuel?: string): 'ascending' | 'descending' | undefined {
  if (!tri || !actuel) return undefined;
  if (actuel === tri.asc) return 'ascending';
  if (actuel === tri.desc) return 'descending';
  return undefined;
}

/**
 * Tableau paginé par curseur (docs/08 §7) : tri par en-tête, sélection multiple avec actions de masse,
 * états chargement / erreur / vide. L'état (tri, page) est porté par l'URL via `useRechercheTableau`.
 */
export function TableauDonnees<T>({
  libelle,
  colonnes,
  lignes,
  cleLigne,
  libelleLigne,
  chargement = false,
  erreur,
  tri,
  onTri,
  pagination,
  actionsSelection,
  messageVide = t('commun.aucuneDonnee'),
  largeurMin = 900,
}: {
  libelle: string;
  colonnes: Colonne<T>[];
  lignes: readonly T[] | undefined;
  cleLigne: (ligne: T) => string;
  /** Nom lisible de la ligne, pour la case de sélection (lecteurs d'écran). */
  libelleLigne?: (ligne: T) => string;
  chargement?: boolean;
  erreur?: unknown;
  tri?: string;
  onTri?: (tri: string) => void;
  pagination?: {
    aPrecedente: boolean;
    precedente: () => void;
    curseurSuivant?: string | null;
    suivante: (curseur: string) => void;
  };
  /** Active la sélection multiple ; reçoit les lignes sélectionnées de la page. */
  actionsSelection?: (selection: T[]) => ReactNode;
  messageVide?: string;
  largeurMin?: number;
}) {
  // Sélection rattachée à la page affichée : elle repart à zéro quand les lignes changent.
  const [selection, setSelection] = useState<{ source?: readonly T[]; ids: Set<string> }>({
    ids: new Set(),
  });
  const ids = selection.source === lignes ? selection.ids : new Set<string>();
  const selectionnable = Boolean(actionsSelection);
  const toutes = lignes ?? [];
  const toutesCochees = toutes.length > 0 && toutes.every((l) => ids.has(cleLigne(l)));
  const choisies = toutes.filter((l) => ids.has(cleLigne(l)));

  const basculer = (cle: string) => {
    const suivants = new Set(ids);
    if (suivants.has(cle)) suivants.delete(cle);
    else suivants.add(cle);
    setSelection({ source: lignes, ids: suivants });
  };
  const basculerTout = () =>
    setSelection({ source: lignes, ids: toutesCochees ? new Set() : new Set(toutes.map(cleLigne)) });

  const suivant = pagination?.curseurSuivant;

  return (
    <Stack gap="sm">
      {selectionnable && choisies.length > 0 && (
        <Group
          gap="sm"
          p="sm"
          style={{ background: '#E7F3F1', borderRadius: 12 }}
          role="region"
          aria-label={t('tableau.actionsSelection')}
        >
          <Text size="sm" fw={600}>
            {t('tableau.selection', { n: choisies.length })}
          </Text>
          {actionsSelection?.(choisies)}
        </Group>
      )}

      <Card withBorder radius={12} padding={0} style={{ borderColor: '#E3E6EA' }}>
        {chargement && (
          <Group justify="center" p="xl">
            <Loader aria-label={t('commun.chargement')} />
          </Group>
        )}
        {!chargement && Boolean(erreur) && (
          <Alert color="red" role="alert" m="md">
            {messageErreur(erreur)}
          </Alert>
        )}
        {!chargement && !erreur && lignes && lignes.length === 0 && (
          <Text c="dimmed" p="lg">
            {messageVide}
          </Text>
        )}
        {!chargement && !erreur && lignes && lignes.length > 0 && (
          <ScrollArea>
            <Table
              verticalSpacing="sm"
              horizontalSpacing="md"
              highlightOnHover
              miw={largeurMin}
              aria-label={libelle}
            >
              <Table.Thead>
                <Table.Tr>
                  {selectionnable && (
                    <Table.Th w={48}>
                      <Checkbox
                        aria-label={t('tableau.toutSelectionner')}
                        checked={toutesCochees}
                        indeterminate={!toutesCochees && choisies.length > 0}
                        onChange={basculerTout}
                      />
                    </Table.Th>
                  )}
                  {colonnes.map((c) => {
                    const sens = sensTri(c.tri, tri);
                    const prochain = triSuivant(c.tri, tri);
                    return (
                      <Table.Th key={c.cle} aria-sort={sens}>
                        {c.tri && onTri && prochain ? (
                          <UnstyledButton
                            onClick={() => onTri(prochain)}
                            fw={600}
                            fz="sm"
                            mih={32}
                            aria-label={t('tableau.trierPar', { colonne: c.titre })}
                          >
                            {c.titre}{' '}
                            <span aria-hidden>
                              {sens === 'ascending' ? '↑' : sens === 'descending' ? '↓' : '↕'}
                            </span>
                          </UnstyledButton>
                        ) : (
                          c.titre
                        )}
                      </Table.Th>
                    );
                  })}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {lignes.map((l) => {
                  const cle = cleLigne(l);
                  return (
                    <Table.Tr key={cle} bg={ids.has(cle) ? '#F1F8F7' : undefined}>
                      {selectionnable && (
                        <Table.Td>
                          <Checkbox
                            aria-label={t('tableau.selectionner', { ligne: libelleLigne?.(l) ?? cle })}
                            checked={ids.has(cle)}
                            onChange={() => basculer(cle)}
                          />
                        </Table.Td>
                      )}
                      {colonnes.map((c) => (
                        <Table.Td key={c.cle}>{c.rendu(l)}</Table.Td>
                      ))}
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>

      {pagination && (pagination.aPrecedente || suivant) && (
        <Group justify="flex-end">
          <Button variant="default" disabled={!pagination.aPrecedente} onClick={pagination.precedente}>
            {t('commun.pagePrecedente')}
          </Button>
          <Button
            variant="default"
            disabled={!suivant}
            onClick={() => suivant && pagination.suivante(suivant)}
          >
            {t('commun.pageSuivante')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

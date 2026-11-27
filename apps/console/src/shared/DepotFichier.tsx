import { Button, Group, Input, Text, VisuallyHidden } from '@mantine/core';
import { useId, useState } from 'react';
import { t } from '../i18n';

const TYPES_LISIBLES: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'application/pdf': 'PDF',
  'text/csv': 'CSV',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-excel': 'CSV',
};

const enMo = (octets: number) => `${Math.round((octets / (1024 * 1024)) * 10) / 10} Mo`;

const libellesTypes = (types: readonly string[]) =>
  [...new Set(types.map((m) => TYPES_LISIBLES[m] ?? m))].join(', ');

/**
 * Contrôle côté client du type et de la taille (docs/07 §6, docs/08 §7) ; renvoie le message d'erreur.
 * `extensions` accepte aussi un fichier par son extension (navigateurs qui ne typent pas les CSV).
 */
export function verifierFichier(
  fichier: File,
  types: readonly string[],
  tailleMax: number,
  extensions: readonly string[] = [],
): string | undefined {
  const extension = fichier.name.includes('.') ? fichier.name.split('.').pop()!.toLowerCase() : '';
  if (types.length && !types.includes(fichier.type) && !extensions.includes(extension))
    return t('champs.fichierType', { types: libellesTypes(types) });
  if (fichier.size > tailleMax) return t('champs.fichierTaille', { max: enMo(tailleMax) });
  return undefined;
}

/**
 * Dépôt d'un fichier (photo, logo, import) avec contrôle de type et de taille avant envoi.
 * Seul un fichier accepté est transmis à `onFichier`.
 */
export function DepotFichier({
  label,
  types,
  tailleMax,
  onFichier,
  enCours = false,
  extensions = [],
}: {
  label: string;
  types: readonly string[];
  tailleMax: number;
  extensions?: readonly string[];
  onFichier: (fichier: File) => void;
  enCours?: boolean;
}) {
  const id = useId();
  const [nom, setNom] = useState<string>();
  const [erreur, setErreur] = useState<string>();
  const aide = t('champs.fichierAide', {
    types: libellesTypes(types),
    max: enMo(tailleMax),
  });

  return (
    <Input.Wrapper label={label} description={aide} error={erreur} id={id}>
      <Group gap="sm" mt={4}>
        <Button component="label" htmlFor={id} variant="default" loading={enCours} mih={44}>
          {t('champs.choisirFichier')}
        </Button>
        <VisuallyHidden>
          <input
            id={id}
            type="file"
            accept={[...types, ...extensions.map((e) => `.${e}`)].join(',')}
            aria-describedby={erreur ? `${id}-error` : `${id}-description`}
            onChange={(e) => {
              const fichier = e.currentTarget.files?.[0];
              // Permet de choisir de nouveau le même fichier après une erreur.
              e.currentTarget.value = '';
              if (!fichier) return;
              const probleme = verifierFichier(fichier, types, tailleMax, extensions);
              setErreur(probleme);
              setNom(probleme ? undefined : fichier.name);
              if (!probleme) onFichier(fichier);
            }}
          />
        </VisuallyHidden>
        {nom && (
          <Text size="sm" c="dimmed">
            {nom}
          </Text>
        )}
      </Group>
    </Input.Wrapper>
  );
}

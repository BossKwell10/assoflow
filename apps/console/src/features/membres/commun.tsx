import { masquerTelephone } from '@assoflow/contracts';
import { Card, Center, Loader, Text } from '@mantine/core';
import type { QueryClient } from '@tanstack/react-query';
import { useGetCategoriesMembres, useGetFamilles } from '../../api/generated/membres/membres';
import type { Membre } from '../../api/generated/modeles';
import { useSession } from '../../auth/SessionProvider';
import { t } from '../../i18n';
import { formatTelephone } from '../../shared/format';

export const TAILLE_PAGE = 50;

/** « KONÉ Awa » : nom puis prénoms, comme sur la carte de membre. */
export const nomMembre = (m: Pick<Membre, 'nom' | 'prenoms'>) => `${m.nom} ${m.prenoms}`.trim();

/**
 * Affichage du téléphone : masqué partiellement pour le commissaire aux comptes (docs/08 A2),
 * dont le rôle est le contrôle et non le contact des membres.
 */
export function useAffichageTelephone() {
  const { associationActive } = useSession();
  const masquer = associationActive?.role.code === 'commissaire';
  return (telephone: string | null | undefined) =>
    telephone ? (masquer ? masquerTelephone(telephone) : formatTelephone(telephone)) : '—';
}

/**
 * Libellés des catégories et des familles : le contrat ne renvoie que les identifiants dans `Membre`
 * (écart signalé). Les familles sont limitées à la première page de 200.
 */
export function useReferentielsMembres() {
  const categories = useGetCategoriesMembres({ query: { staleTime: 5 * 60_000 } });
  const familles = useGetFamilles({ limite: 200 }, { query: { staleTime: 60_000 } });
  const categorie = new Map((categories.data ?? []).map((c) => [c.id ?? '', c.libelle]));
  const famille = new Map((familles.data?.donnees ?? []).map((f) => [f.id ?? '', f]));
  return {
    categories: categories.data ?? [],
    familles: familles.data?.donnees ?? [],
    libelleCategorie: (id?: string | null) => (id ? (categorie.get(id) ?? '') : ''),
    famille: (id?: string | null) => (id ? famille.get(id) : undefined),
  };
}

/** Invalide les listes et fiches de membres et de familles après une écriture. */
export const invaliderMembres = (client: QueryClient) =>
  client.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === 'string' &&
      (q.queryKey[0].startsWith('/membres') || q.queryKey[0].startsWith('/familles')),
  });

export const Chargement = () => (
  <Center p="xl">
    <Loader aria-label={t('commun.chargement')} />
  </Center>
);

/** Pays de résidence proposés (ISO 3166-1) : Côte d'Ivoire par défaut, puis la diaspora la plus fréquente. */
export const PAYS: { code: string; nom: string }[] = [
  { code: 'CI', nom: 'Côte d’Ivoire' },
  { code: 'FR', nom: 'France' },
  { code: 'US', nom: 'États-Unis' },
  { code: 'CA', nom: 'Canada' },
  { code: 'IT', nom: 'Italie' },
  { code: 'BE', nom: 'Belgique' },
  { code: 'DE', nom: 'Allemagne' },
  { code: 'ES', nom: 'Espagne' },
  { code: 'GB', nom: 'Royaume-Uni' },
  { code: 'CH', nom: 'Suisse' },
  { code: 'BF', nom: 'Burkina Faso' },
  { code: 'ML', nom: 'Mali' },
  { code: 'SN', nom: 'Sénégal' },
  { code: 'GH', nom: 'Ghana' },
  { code: 'GN', nom: 'Guinée' },
  { code: 'TG', nom: 'Togo' },
  { code: 'BJ', nom: 'Bénin' },
  { code: 'NE', nom: 'Niger' },
  { code: 'CM', nom: 'Cameroun' },
  { code: 'MA', nom: 'Maroc' },
  { code: 'CN', nom: 'Chine' },
];
export const nomPays = (code?: string | null) => PAYS.find((p) => p.code === code)?.nom ?? code ?? '';

/** Onglet ou action livré dans un sprint ultérieur. */
export const Bientot = ({ sprint }: { sprint: string }) => (
  <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
    <Text c="dimmed">{t('aPlusTard.message', { sprint })}</Text>
  </Card>
);

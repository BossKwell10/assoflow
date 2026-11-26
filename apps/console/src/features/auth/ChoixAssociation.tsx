import { Alert, Button, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../auth/SessionProvider';
import { t } from '../../i18n';
import { messageErreur } from '../../shared/erreurs';
import { PageAuth } from './PageAuth';
import { cheminRetour } from './redirection';

/** A0 — choix de l'association active après connexion (`POST /auth/contexte`). */
export function ChoixAssociation() {
  const router = useRouter();
  const recherche = useSearch({ strict: false }) as { redirect?: string };
  const { utilisateur, choisirAssociation, deconnecter } = useSession();
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState<string>();
  const autoChoisi = useRef(false);
  const acces = utilisateur?.acces ?? [];

  const choisir = async (associationId: string) => {
    setEnCours(associationId);
    setErreur(undefined);
    try {
      await choisirAssociation(associationId);
      void router.history.push(cheminRetour(recherche.redirect));
    } catch (e) {
      setErreur(messageErreur(e));
      setEnCours(undefined);
    }
  };

  // Un seul accès : pas de choix à faire.
  const unique = acces.length === 1 ? acces[0]?.associationId : undefined;
  useEffect(() => {
    if (unique && !autoChoisi.current) {
      autoChoisi.current = true;
      void choisir(unique);
    }
  });

  if (unique && !erreur) {
    return (
      <PageAuth titre={t('choixAssociation.titre')}>
        <Loader aria-label={t('commun.chargement')} mx="auto" />
      </PageAuth>
    );
  }

  return (
    <PageAuth
      titre={t('choixAssociation.titre')}
      sousTitre={acces.length > 1 ? t('choixAssociation.intro') : undefined}
    >
      {erreur && (
        <Alert color="red" role="alert">
          {erreur}
        </Alert>
      )}
      {acces.length === 0 ? (
        <Text>{t('choixAssociation.aucunAcces')}</Text>
      ) : (
        <Stack gap="xs" component="ul" p={0} m={0} style={{ listStyle: 'none' }}>
          {acces.map((a) => (
            <li key={a.associationId}>
              <UnstyledButton
                onClick={() => a.associationId && void choisir(a.associationId)}
                disabled={!!enCours}
                w="100%"
                p="md"
                mih={44}
                style={{ border: '1px solid #E3E6EA', borderRadius: 12 }}
                aria-busy={enCours === a.associationId}
              >
                <Text fw={600}>{a.associationNom}</Text>
                {a.role?.libelle && (
                  <Text size="sm" c="dimmed">
                    {t('choixAssociation.role', { role: a.role.libelle })}
                  </Text>
                )}
              </UnstyledButton>
            </li>
          ))}
        </Stack>
      )}
      <Button variant="subtle" onClick={() => void deconnecter('volontaire')}>
        {t('entete.seDeconnecter')}
      </Button>
    </PageAuth>
  );
}

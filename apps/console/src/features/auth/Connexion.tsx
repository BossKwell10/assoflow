import { normaliserTelephone } from '@assoflow/contracts';
import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { useCallback, useState, type FormEvent } from 'react';
import { estErreurApi } from '../../api/erreurs';
import { ouvrirSession } from '../../api/jeton';
import { postAuthConnexion, postAuthTotp } from '../../api/generated/authentification/authentification';
import type { EtapeTotp, Session } from '../../api/generated/modeles';
import { useSession } from '../../auth/SessionProvider';
import { t } from '../../i18n';
import { messageErreur } from '../../shared/erreurs';
import { formatDuree } from '../../shared/format';
import { ActivationTotp } from './ActivationTotp';
import { PageAuth } from './PageAuth';
import { cheminRetour } from './redirection';

/** Email si « @ », sinon téléphone normalisé en E.164 (RG-MBR-007). */
export function normaliserIdentifiant(saisie: string): string {
  const brut = saisie.trim();
  if (brut.includes('@')) return brut.toLowerCase();
  return normaliserTelephone(brut);
}

function messageConnexion(erreur: unknown): string {
  if (!estErreurApi(erreur)) return messageErreur(erreur);
  switch (erreur.code) {
    case 'IDENTIFIANTS_INVALIDES':
    case 'VALIDATION':
      return t('connexion.identifiantsInvalides');
    case 'COMPTE_VERROUILLE':
      return erreur.reessayerApres
        ? t('connexion.compteVerrouilleDuree', { duree: formatDuree(erreur.reessayerApres) })
        : (erreur.probleme.detail ?? t('connexion.compteVerrouille'));
    case 'TENANT_SUSPENDU':
      return t('connexion.tenantSuspendu');
    case 'TROP_DE_REQUETES':
      return t('connexion.tropDeRequetes');
    default:
      return messageErreur(erreur);
  }
}

const MESSAGES_MOTIF = {
  inactivite: 'connexion.deconnecteInactivite',
  expiree: 'connexion.sessionExpiree',
  volontaire: 'connexion.deconnecte',
} as const;

/** A0 — `/connexion` : identifiant + mot de passe, puis étape TOTP si demandée (docs/04 §2.2). */
export function Connexion() {
  const router = useRouter();
  const recherche = useSearch({ strict: false }) as { redirect?: string };
  const { motif } = useSession();
  // Le jeton intermédiaire (5 min) reste en mémoire dans ce composant : jamais dans l'URL ni le stockage.
  const [etape, setEtape] = useState<EtapeTotp>();
  const [expire, setExpire] = useState(false);

  const terminer = (session: Session) => {
    ouvrirSession(session);
    void router.history.push(cheminRetour(recherche.redirect));
  };
  const surExpiration = useCallback(() => {
    setEtape(undefined);
    setExpire(true);
  }, []);

  if (etape?.etape === 'totp_activation') {
    return (
      <ActivationTotp
        jetonIntermediaire={etape.jetonIntermediaire}
        onSession={terminer}
        onExpire={surExpiration}
      />
    );
  }
  if (etape?.etape === 'totp') {
    return (
      <SaisieTotp
        jetonIntermediaire={etape.jetonIntermediaire}
        onSession={terminer}
        onExpire={surExpiration}
      />
    );
  }
  return (
    <FormulaireConnexion
      messageMotif={expire ? t('totp.jetonExpire') : motif ? t(MESSAGES_MOTIF[motif]) : undefined}
      onSession={terminer}
      onEtape={(e) => {
        setExpire(false);
        setEtape(e);
      }}
    />
  );
}

function FormulaireConnexion({
  messageMotif,
  onSession,
  onEtape,
}: {
  messageMotif?: string;
  onSession: (s: Session) => void;
  onEtape: (etape: EtapeTotp) => void;
}) {
  const [identifiant, setIdentifiant] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreurs, setErreurs] = useState<{ identifiant?: string; motDePasse?: string }>({});
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState(false);

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    setErreur(undefined);
    const champs = {
      identifiant: identifiant.trim() ? undefined : t('connexion.champRequis'),
      motDePasse: motDePasse ? undefined : t('connexion.champRequis'),
    };
    let identifiantNormalise = '';
    if (!champs.identifiant) {
      try {
        identifiantNormalise = normaliserIdentifiant(identifiant);
      } catch {
        champs.identifiant = t('connexion.telephoneInvalide');
      }
    }
    setErreurs(champs);
    if (champs.identifiant || champs.motDePasse) return;

    setEnCours(true);
    try {
      const reponse = await postAuthConnexion({
        identifiant: identifiantNormalise,
        motDePasse,
        canal: 'console',
      });
      if ('etape' in reponse) onEtape(reponse);
      else onSession(reponse);
    } catch (err) {
      setErreur(messageConnexion(err));
      setMotDePasse('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <PageAuth titre={t('connexion.titre')} sousTitre={t('connexion.sousTitre')}>
      {messageMotif && !erreur && (
        <Alert color="gray" role="status">
          {messageMotif}
        </Alert>
      )}
      {erreur && (
        <Alert color="red" role="alert">
          {erreur}
        </Alert>
      )}
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack>
          <TextInput
            label={t('connexion.identifiant')}
            description={t('connexion.identifiantAide')}
            autoComplete="username"
            required
            size="md"
            value={identifiant}
            onChange={(e) => setIdentifiant(e.currentTarget.value)}
            error={erreurs.identifiant}
          />
          <PasswordInput
            label={t('connexion.motDePasse')}
            autoComplete="current-password"
            required
            size="md"
            value={motDePasse}
            onChange={(e) => setMotDePasse(e.currentTarget.value)}
            error={erreurs.motDePasse}
          />
          <Button type="submit" size="md" loading={enCours} fullWidth>
            {t('connexion.seConnecter')}
          </Button>
        </Stack>
      </form>
      <Stack gap={4} align="center">
        <Anchor component={Link} to="/mot-de-passe-oublie" size="sm">
          {t('connexion.motDePasseOublie')}
        </Anchor>
        <Anchor component={Link} to="/premier-acces" size="sm">
          {t('connexion.premierAcces')}
        </Anchor>
      </Stack>
    </PageAuth>
  );
}

function SaisieTotp({
  jetonIntermediaire,
  onSession,
  onExpire,
}: {
  jetonIntermediaire: string;
  onSession: (s: Session) => void;
  onExpire: () => void;
}) {
  const [secours, setSecours] = useState(false);
  const [code, setCode] = useState('');
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState(false);

  const soumettre = async (e?: FormEvent) => {
    e?.preventDefault();
    const valeur = code.trim();
    if (!secours && !/^\d{6}$/.test(valeur)) {
      setErreur(t('totp.formatCode'));
      return;
    }
    if (!valeur) return;
    setEnCours(true);
    setErreur(undefined);
    try {
      onSession(await postAuthTotp({ jetonIntermediaire, code: valeur }));
    } catch (err) {
      if (estErreurApi(err) && (err.code === 'JETON_EXPIRE' || err.code === 'NON_AUTHENTIFIE')) {
        onExpire();
        return;
      }
      setErreur(
        estErreurApi(err) && err.code === 'TOTP_INVALIDE' ? t('totp.codeInvalide') : messageConnexion(err),
      );
      setCode('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <PageAuth titre={t('totp.titre')}>
      <Text size="sm">{secours ? t('totp.instructionSecours') : t('totp.instruction')}</Text>
      {erreur && (
        <Alert color="red" role="alert">
          {erreur}
        </Alert>
      )}
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack>
          {secours ? (
            <TextInput
              label={t('totp.codeSecours')}
              autoComplete="one-time-code"
              size="md"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              data-autofocus
            />
          ) : (
            <TextInput
              label={t('totp.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              size="md"
              styles={{ input: { letterSpacing: '0.4em', fontVariantNumeric: 'tabular-nums' } }}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))}
              data-autofocus
              autoFocus
            />
          )}
          <Button type="submit" size="md" loading={enCours} fullWidth>
            {t('totp.valider')}
          </Button>
        </Stack>
      </form>
      <UnstyledButton
        onClick={() => {
          setSecours((s) => !s);
          setCode('');
          setErreur(undefined);
        }}
        c="accent.7"
        fz="sm"
        style={{ alignSelf: 'center', minHeight: 44, textDecoration: 'underline' }}
      >
        {secours ? t('totp.utiliserApplication') : t('totp.utiliserSecours')}
      </UnstyledButton>
    </PageAuth>
  );
}

import { normaliserTelephone } from '@assoflow/contracts';
import { Alert, Anchor, Button, Checkbox, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type FormEvent } from 'react';
import { estErreurApi } from '../../api/erreurs';
import {
  postAuthMotDePasse,
  postAuthOtpDemander,
  postAuthOtpVerifier,
} from '../../api/generated/authentification/authentification';
import { t } from '../../i18n';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';
import { formatDuree } from '../../shared/format';
import { PageAuth } from './PageAuth';
import { evaluerMotDePasse, ReglesMotDePasse } from './ReglesMotDePasse';

type Mode = 'reinitialisation' | 'inscription';
type Etape = 'telephone' | 'code' | 'motDePasse' | 'termine';

function messageOtp(erreur: unknown): string {
  if (estErreurApi(erreur)) {
    if (erreur.code === 'OTP_INVALIDE') return t('otp.codeInvalide');
    if (erreur.code === 'OTP_EXPIRE') return t('otp.codeExpire');
    if (erreur.code === 'MOT_DE_PASSE_FAIBLE') return erreur.probleme.detail ?? t('otp.motDePasseFaible');
    if (erreur.code === 'TROP_DE_REQUETES') {
      return erreur.reessayerApres
        ? t('otp.tropDeDemandes', { duree: formatDuree(erreur.reessayerApres) })
        : t('connexion.tropDeRequetes');
    }
  }
  return messageErreur(erreur);
}

/**
 * A0 — `/mot-de-passe-oublie` (RF-004) et `/premier-acces` (RF-001, invitation) :
 * téléphone → OTP SMS → nouveau mot de passe (règles en direct) → CGU au premier accès.
 */
export function DefinitionMotDePasse({ mode }: { mode: Mode }) {
  const [etape, setEtape] = useState<Etape>('telephone');
  const [saisieTelephone, setSaisieTelephone] = useState('');
  const [telephone, setTelephone] = useState('');
  const [code, setCode] = useState('');
  const [jetonOtp, setJetonOtp] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [cgu, setCgu] = useState(false);
  const [traitement, setTraitement] = useState(false);
  const [consentementTouche, setConsentementTouche] = useState(false);
  // Au premier accès, les consentements sont toujours demandés ; en réinitialisation, seulement si l'API
  // les exige (textes jamais acceptés ou nouvelle version : 422 VALIDATION sur accepteCgu / accepteTraitementDonnees).
  const [consentementDemande, setConsentementDemande] = useState(mode === 'inscription');
  const [erreur, setErreur] = useState<string>();
  const [erreurChamp, setErreurChamp] = useState<string>();
  const [enCours, setEnCours] = useState(false);
  const evaluation = useMemo(
    () => evaluerMotDePasse(motDePasse, confirmation, telephone),
    [motDePasse, confirmation, telephone],
  );

  const executer = async (action: () => Promise<void>) => {
    setEnCours(true);
    setErreur(undefined);
    try {
      await action();
    } catch (e) {
      setErreur(messageOtp(e));
    } finally {
      setEnCours(false);
    }
  };

  const demanderCode = (e?: FormEvent) => {
    e?.preventDefault();
    let e164: string;
    try {
      e164 = normaliserTelephone(saisieTelephone);
    } catch {
      setErreurChamp(t('connexion.telephoneInvalide'));
      return;
    }
    setErreurChamp(undefined);
    void executer(async () => {
      await postAuthOtpDemander({ telephone: e164, but: mode });
      setTelephone(e164);
      setCode('');
      setEtape('code');
    });
  };

  const verifierCode = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setErreurChamp(t('totp.formatCode'));
      return;
    }
    setErreurChamp(undefined);
    void executer(async () => {
      const r = await postAuthOtpVerifier({ telephone, code, but: mode });
      setJetonOtp(r.jetonOtp);
      setEtape('motDePasse');
    });
  };

  const enregistrer = (e: FormEvent) => {
    e.preventDefault();
    setConsentementTouche(true);
    if (!evaluation.valide || (consentementDemande && (!cgu || !traitement))) return;
    void executer(async () => {
      try {
        await postAuthMotDePasse({
          jetonOtp,
          motDePasse,
          canal: 'console',
          ...(consentementDemande ? { accepteCgu: cgu, accepteTraitementDonnees: traitement } : {}),
        });
      } catch (err) {
        const champs = erreursDeChamps(err);
        if ('accepteCgu' in champs || 'accepteTraitementDonnees' in champs) {
          setConsentementDemande(true);
          setConsentementTouche(false);
          setErreur(t('otp.consentementRequis'));
          return;
        }
        throw err;
      }
      setEtape('termine');
    });
  };

  const titre = mode === 'inscription' ? t('otp.titrePremierAcces') : t('otp.titreOubli');
  const retour = (
    <Anchor component={Link} to="/connexion" size="sm" ta="center">
      {t('otp.retourConnexion')}
    </Anchor>
  );
  const alerte = erreur && (
    <Alert color="red" role="alert">
      {erreur}
    </Alert>
  );

  if (etape === 'termine') {
    return (
      <PageAuth titre={titre}>
        <Alert color="green" role="status">
          {t('otp.succes')}
        </Alert>
        <Button component={Link} to="/connexion" size="md">
          {t('connexion.seConnecter')}
        </Button>
      </PageAuth>
    );
  }

  if (etape === 'telephone') {
    return (
      <PageAuth titre={titre}>
        <Text size="sm">{mode === 'inscription' ? t('otp.introPremierAcces') : t('otp.introOubli')}</Text>
        {alerte}
        <form onSubmit={demanderCode} noValidate>
          <Stack>
            <TextInput
              label={t('otp.telephone')}
              description={t('otp.telephoneAide')}
              type="tel"
              autoComplete="tel"
              required
              size="md"
              value={saisieTelephone}
              onChange={(e) => setSaisieTelephone(e.currentTarget.value)}
              error={erreurChamp}
            />
            <Button type="submit" size="md" loading={enCours}>
              {t('otp.envoyerCode')}
            </Button>
          </Stack>
        </form>
        {retour}
      </PageAuth>
    );
  }

  if (etape === 'code') {
    return (
      <PageAuth titre={titre}>
        <Text size="sm" role="status">
          {t('otp.codeEnvoye', { telephone })}
        </Text>
        {alerte}
        <form onSubmit={verifierCode} noValidate>
          <Stack>
            <TextInput
              label={t('otp.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              size="md"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))}
              error={erreurChamp}
              data-autofocus
            />
            <Button type="submit" size="md" loading={enCours}>
              {t('otp.verifier')}
            </Button>
            <Button variant="subtle" onClick={() => demanderCode()} disabled={enCours}>
              {t('otp.renvoyer')}
            </Button>
          </Stack>
        </form>
        {retour}
      </PageAuth>
    );
  }

  return (
    <PageAuth titre={titre}>
      {alerte}
      <form onSubmit={enregistrer} noValidate>
        <Stack>
          <PasswordInput
            label={t('otp.nouveauMotDePasse')}
            autoComplete="new-password"
            required
            size="md"
            value={motDePasse}
            onChange={(e) => setMotDePasse(e.currentTarget.value)}
            aria-describedby="regles-mot-de-passe"
          />
          <PasswordInput
            label={t('otp.confirmation')}
            autoComplete="new-password"
            required
            size="md"
            value={confirmation}
            onChange={(e) => setConfirmation(e.currentTarget.value)}
            error={confirmation && confirmation !== motDePasse ? t('otp.differents') : undefined}
          />
          <ReglesMotDePasse regles={evaluation.regles} />
          {consentementDemande && (
            <>
              <Checkbox
                label={t('otp.cgu')}
                checked={cgu}
                onChange={(e) => setCgu(e.currentTarget.checked)}
                error={consentementTouche && !cgu ? t('otp.cguRequises') : undefined}
              />
              <Checkbox
                label={t('otp.traitementDonnees')}
                checked={traitement}
                onChange={(e) => setTraitement(e.currentTarget.checked)}
                error={consentementTouche && !traitement ? t('otp.traitementRequis') : undefined}
              />
            </>
          )}
          <Button type="submit" size="md" loading={enCours}>
            {t('otp.enregistrer')}
          </Button>
        </Stack>
      </form>
      {retour}
    </PageAuth>
  );
}

export const MotDePasseOublie = () => <DefinitionMotDePasse mode="reinitialisation" />;
export const PremierAcces = () => <DefinitionMotDePasse mode="inscription" />;

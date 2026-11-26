import {
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Image,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useState, type FormEvent } from 'react';
import { estErreurApi, type ErreurApi } from '../../api/erreurs';
import {
  postAuthTotpActivation,
  postAuthTotpConfirmation,
} from '../../api/generated/authentification/authentification';
import type { Session } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { messageErreur } from '../../shared/erreurs';
import { PageAuth } from './PageAuth';

function telechargerCodes(codes: string[]) {
  const contenu = [t('activationTotp.fichierEntete'), '', ...codes, ''].join('\n');
  const url = URL.createObjectURL(new Blob([contenu], { type: 'text/plain;charset=utf-8' }));
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = 'assoflow-codes-de-secours.txt';
  lien.click();
  URL.revokeObjectURL(url);
}

/**
 * Une seule activation par jeton : chaque appel génère un nouveau secret côté serveur, or le double
 * montage des effets (StrictMode) en lancerait deux.
 */
const activations = new Map<string, ReturnType<typeof postAuthTotpActivation>>();
function demarrerActivation(jeton: string) {
  let activation = activations.get(jeton);
  if (!activation) {
    activation = postAuthTotpActivation({ headers: { Authorization: `Bearer ${jeton}` } });
    activations.set(jeton, activation);
    activation.catch(() => activations.delete(jeton));
  }
  return activation;
}

const jetonExpire = (e: unknown): e is ErreurApi => estErreurApi(e) && e.statut === 401;
/** Code incorrect : 422 VALIDATION sur le champ `code` (ou TOTP_INVALIDE). */
const codeIncorrect = (e: unknown) =>
  estErreurApi(e) &&
  (e.code === 'TOTP_INVALIDE' ||
    (e.code === 'VALIDATION' && !!e.probleme.erreurs?.some((x) => x.champ === 'code')));

/**
 * A0 — activation TOTP obligatoire avant la première connexion console d'un membre du bureau (RF-003, docs/04 §11).
 * Le jeton intermédiaire `totp_activation` sert de Bearer ; la confirmation renvoie les codes et la session.
 */
export function ActivationTotp({
  jetonIntermediaire,
  onSession,
  onExpire,
}: {
  jetonIntermediaire: string;
  onSession: (s: Session) => void;
  onExpire: () => void;
}) {
  const options = { headers: { Authorization: `Bearer ${jetonIntermediaire}` } };
  const [activation, setActivation] = useState<{ secret?: string; otpauthUrl?: string }>();
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState('');
  const [resultat, setResultat] = useState<{ codesSecours: string[]; session?: Session }>();
  const [conserve, setConserve] = useState(false);
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    let actif = true;
    demarrerActivation(jetonIntermediaire)
      .then(async (a) => {
        if (!actif) return;
        setActivation(a);
        if (a.otpauthUrl) {
          // Chargée à la demande : la bibliothèque QR ne pèse pas sur le bundle initial.
          const { toDataURL } = await import('qrcode');
          const image = await toDataURL(a.otpauthUrl, { margin: 1, width: 200 });
          if (actif) setQr(image);
        }
      })
      .catch((e: unknown) => {
        if (!actif) return;
        if (jetonExpire(e)) onExpire();
        else setErreur(messageErreur(e));
      });
    return () => {
      actif = false;
    };
  }, [jetonIntermediaire, onExpire]);

  const confirmer = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setErreur(t('totp.formatCode'));
      return;
    }
    setEnCours(true);
    setErreur(undefined);
    try {
      setResultat(await postAuthTotpConfirmation({ code }, options));
    } catch (err) {
      if (jetonExpire(err)) onExpire();
      else setErreur(codeIncorrect(err) ? t('totp.codeInvalide') : messageErreur(err));
      setCode('');
    } finally {
      setEnCours(false);
    }
  };

  if (resultat) {
    const { codesSecours, session } = resultat;
    return (
      <PageAuth titre={t('activationTotp.codesTitre')} largeur={520}>
        <Text size="sm">{t('activationTotp.codesIntro')}</Text>
        <SimpleGrid cols={2} spacing="xs" component="ul" p={0} m={0} style={{ listStyle: 'none' }}>
          {codesSecours.map((c) => (
            <li key={c}>
              <Code fz="md" block ta="center">
                {c}
              </Code>
            </li>
          ))}
        </SimpleGrid>
        <Button variant="light" onClick={() => telechargerCodes(codesSecours)}>
          {t('activationTotp.telecharger')}
        </Button>
        <Checkbox
          label={t('activationTotp.conserve')}
          checked={conserve}
          onChange={(e) => setConserve(e.currentTarget.checked)}
        />
        <Button size="md" disabled={!conserve} onClick={() => (session ? onSession(session) : onExpire())}>
          {t('activationTotp.acceder')}
        </Button>
      </PageAuth>
    );
  }

  return (
    <PageAuth titre={t('activationTotp.titre')} sousTitre={t('activationTotp.intro')} largeur={520}>
      {erreur && (
        <Alert color="red" role="alert">
          {erreur}
        </Alert>
      )}
      <Text size="sm">{t('activationTotp.etape1')}</Text>
      <Group justify="center" mih={200}>
        {qr ? (
          <Image src={qr} alt={t('activationTotp.qrAlt')} w={200} h={200} />
        ) : (
          !erreur && <Loader aria-label={t('commun.chargement')} />
        )}
      </Group>
      {activation?.secret && (
        <Stack gap={4}>
          <Text size="sm">{t('activationTotp.secretManuel')}</Text>
          <Code fz="md" ta="center" style={{ wordBreak: 'break-all' }} data-testid="secret-totp">
            {activation.secret}
          </Code>
        </Stack>
      )}
      <form onSubmit={(e) => void confirmer(e)} noValidate>
        <Stack>
          <Text size="sm">{t('activationTotp.etape2')}</Text>
          <TextInput
            label={t('totp.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            size="md"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))}
          />
          <Button type="submit" size="md" loading={enCours} disabled={!activation}>
            {t('activationTotp.activer')}
          </Button>
        </Stack>
      </form>
    </PageAuth>
  );
}

import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { rendreConsole } from '../../test/rendu';
import { probleme, requetesVers, serveur } from '../../test/serveur';

const otpOk = [
  http.post('*/v1/auth/otp/demander', () => new HttpResponse(null, { status: 204 })),
  http.post('*/v1/auth/otp/verifier', async ({ request }) => {
    const { code } = (await request.json()) as { code: string };
    return code === '424242'
      ? HttpResponse.json({ jetonOtp: 'jeton-otp', expireDans: 300 })
      : probleme(401, 'OTP_INVALIDE');
  }),
  http.post('*/v1/auth/mot-de-passe', () => new HttpResponse(null, { status: 204 })),
];

describe('A0 — mot de passe oublié et premier accès', () => {
  it('réinitialise le mot de passe : téléphone → OTP → règles en direct', async () => {
    serveur.use(...otpOk);
    const { utilisateur: u } = rendreConsole('/mot-de-passe-oublie');
    await u.type(await screen.findByLabelText(/Numéro de téléphone/), '07 01 02 03 04');
    await u.click(screen.getByRole('button', { name: 'Recevoir le code par SMS' }));
    expect(await screen.findByText(/envoyé au \+2250701020304/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/otp/demander')[0]?.corps).toEqual({
      telephone: '+2250701020304',
      but: 'reinitialisation',
    });

    await u.type(screen.getByLabelText(/Code reçu par SMS/), '111111');
    await u.click(screen.getByRole('button', { name: 'Vérifier le code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code incorrect.');
    await u.clear(screen.getByLabelText(/Code reçu par SMS/));
    await u.type(screen.getByLabelText(/Code reçu par SMS/), '424242');
    await u.click(screen.getByRole('button', { name: 'Vérifier le code' }));

    const regles = await screen.findByRole('list', { name: 'Votre mot de passe doit :' });
    expect(within(regles).getByText(/au moins 10 caractères/)).toHaveTextContent('règle non respectée');
    await u.type(screen.getByLabelText(/^Nouveau mot de passe/), 'abc0701020304');
    expect(within(regles).getByText(/au moins 10 caractères/)).toHaveTextContent('règle respectée');
    expect(within(regles).getByText(/chiffres de votre numéro/)).toHaveTextContent('règle non respectée');

    await u.clear(screen.getByLabelText(/^Nouveau mot de passe/));
    await u.type(screen.getByLabelText(/^Nouveau mot de passe/), 'baobab-de-Bouaké');
    await u.type(screen.getByLabelText(/^Confirmer le mot de passe/), 'baobab-de-Bouaké');
    expect(screen.queryByLabelText(/conditions générales/)).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));

    expect(await screen.findByText(/Votre mot de passe est enregistré/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/mot-de-passe')[0]?.corps).toEqual({
      jetonOtp: 'jeton-otp',
      motDePasse: 'baobab-de-Bouaké',
      canal: 'console',
    });
  });

  it('au premier accès, impose l’acceptation des CGU', async () => {
    serveur.use(...otpOk);
    const { utilisateur: u } = rendreConsole('/premier-acces');
    await u.type(await screen.findByLabelText(/Numéro de téléphone/), '0701020304');
    await u.click(screen.getByRole('button', { name: 'Recevoir le code par SMS' }));
    await u.type(await screen.findByLabelText(/Code reçu par SMS/), '424242');
    await u.click(screen.getByRole('button', { name: 'Vérifier le code' }));
    expect(requetesVers('POST', '/v1/auth/otp/demander')[0]?.corps).toMatchObject({ but: 'inscription' });

    await u.type(await screen.findByLabelText(/^Nouveau mot de passe/), 'baobab-de-Bouaké');
    await u.type(screen.getByLabelText(/^Confirmer le mot de passe/), 'baobab-de-Bouaké');
    await u.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));
    expect(
      await screen.findByText('Vous devez accepter les conditions générales pour continuer.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Vous devez accepter le traitement de vos données pour continuer.'),
    ).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/mot-de-passe')).toHaveLength(0);

    await u.click(screen.getByLabelText(/conditions générales/));
    await u.click(screen.getByLabelText(/traitement de mes données/));
    await u.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));
    expect(await screen.findByText(/Votre mot de passe est enregistré/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/mot-de-passe')[0]?.corps).toEqual({
      jetonOtp: 'jeton-otp',
      motDePasse: 'baobab-de-Bouaké',
      canal: 'console',
      accepteCgu: true,
      accepteTraitementDonnees: true,
    });
  });

  it('en réinitialisation, demande les consentements si l’API les exige', async () => {
    let appels = 0;
    serveur.use(
      // Avant otpOk : le premier handler correspondant l'emporte.
      http.post('*/v1/auth/mot-de-passe', async ({ request }) => {
        appels++;
        const corps = (await request.json()) as { accepteCgu?: boolean; accepteTraitementDonnees?: boolean };
        if (corps.accepteCgu && corps.accepteTraitementDonnees)
          return new HttpResponse(null, { status: 204 });
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'VALIDATION',
            status: 422,
            code: 'VALIDATION',
            detail: 'Consentement requis',
            erreurs: [{ champ: 'accepteCgu', code: 'CONSENTEMENT_REQUIS', message: 'Acceptez les CGU.' }],
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        );
      }),
      ...otpOk,
    );
    const { utilisateur: u } = rendreConsole('/mot-de-passe-oublie');
    await u.type(await screen.findByLabelText(/Numéro de téléphone/), '0701020304');
    await u.click(screen.getByRole('button', { name: 'Recevoir le code par SMS' }));
    await u.type(await screen.findByLabelText(/Code reçu par SMS/), '424242');
    await u.click(screen.getByRole('button', { name: 'Vérifier le code' }));
    await u.type(await screen.findByLabelText(/^Nouveau mot de passe/), 'baobab-de-Bouaké');
    await u.type(screen.getByLabelText(/^Confirmer le mot de passe/), 'baobab-de-Bouaké');
    await u.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /conditions d’utilisation ont été mises à jour/,
    );
    await u.click(screen.getByLabelText(/conditions générales/));
    await u.click(screen.getByLabelText(/traitement de mes données/));
    await u.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));
    expect(await screen.findByText(/Votre mot de passe est enregistré/)).toBeInTheDocument();
    expect(appels).toBe(2);
  });

  it('affiche le délai d’attente quand trop de codes ont été demandés (429)', async () => {
    serveur.use(
      http.post('*/v1/auth/otp/demander', () =>
        probleme(429, 'TROP_DE_REQUETES', 'Trop de demandes', { 'Retry-After': '600' }),
      ),
    );
    const { utilisateur: u } = rendreConsole('/premier-acces');
    await u.type(await screen.findByLabelText(/Numéro de téléphone/), '0701020304');
    await u.click(screen.getByRole('button', { name: 'Recevoir le code par SMS' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Trop de demandes de code pour ce numéro. Réessayez dans 10 minutes.',
    );
  });
});

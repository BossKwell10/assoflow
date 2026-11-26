import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { session, utilisateur } from '../../test/donnees';
import { rendreConsole } from '../../test/rendu';
import { etatServeur, probleme, requetesVers, serveur } from '../../test/serveur';

async function saisirIdentifiants(
  u: ReturnType<typeof rendreConsole>['utilisateur'],
  id: string,
  mdp: string,
) {
  await u.type(await screen.findByLabelText(/Téléphone ou email/), id);
  await u.type(screen.getByLabelText(/Mot de passe/, { selector: 'input' }), mdp);
  await u.click(screen.getByRole('button', { name: 'Se connecter' }));
}

describe('A0 — connexion', () => {
  it('connecte sans TOTP, avec téléphone normalisé, et ouvre le tableau de bord', async () => {
    const s = session();
    serveur.use(
      http.post('*/v1/auth/connexion', () => {
        etatServeur.sessionCookie = s;
        return HttpResponse.json(s);
      }),
    );
    const { utilisateur: u, routeur } = rendreConsole('/connexion');
    await saisirIdentifiants(u, '07 01 02 03 04', 'motdepasse-solide');

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    expect(routeur.state.location.pathname).toBe('/');
    expect(requetesVers('POST', '/v1/auth/connexion')[0]?.corps).toEqual({
      identifiant: '+2250701020304',
      motDePasse: 'motdepasse-solide',
      canal: 'console',
    });
    // L'en-tête affiche l'association active, son exercice et le menu utilisateur.
    expect(screen.getByText('Mutuelle de Bécédi')).toBeInTheDocument();
    expect(await screen.findByText('Exercice 2027')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu utilisateur' })).toBeInTheDocument();
  });

  it('demande le code TOTP quand la réponse est une étape totp, puis permet un code de secours', async () => {
    const s = session();
    serveur.use(
      http.post('*/v1/auth/connexion', () =>
        HttpResponse.json({ etape: 'totp', jetonIntermediaire: 'jeton-5min' }),
      ),
      http.post('*/v1/auth/totp', async ({ request }) => {
        const { code } = (await request.json()) as { code: string };
        if (code !== 'ABCD-EFGH') return probleme(401, 'TOTP_INVALIDE');
        etatServeur.sessionCookie = s;
        return HttpResponse.json(s);
      }),
    );
    const { utilisateur: u } = rendreConsole('/connexion?redirect=/membres');
    await saisirIdentifiants(u, 'awa.kone@exemple.ci', 'motdepasse-solide');

    expect(await screen.findByRole('heading', { name: 'Vérification en deux étapes' })).toBeInTheDocument();
    await u.type(screen.getByLabelText(/Code à 6 chiffres/), '123456');
    await u.click(screen.getByRole('button', { name: 'Valider' }));
    expect(await screen.findByText(/Code incorrect/)).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/totp')[0]?.corps).toEqual({
      jetonIntermediaire: 'jeton-5min',
      code: '123456',
    });

    await u.click(screen.getByRole('button', { name: 'Utiliser un code de secours' }));
    await u.type(screen.getByLabelText(/Code de secours/), 'ABCD-EFGH');
    await u.click(screen.getByRole('button', { name: 'Valider' }));
    // Retour à la page demandée avant la connexion.
    expect(await screen.findByRole('heading', { name: 'Membres' })).toBeInTheDocument();
  });

  it('affiche un message unique pour des identifiants invalides', async () => {
    const { utilisateur: u } = rendreConsole('/connexion');
    await saisirIdentifiants(u, 'inconnu@exemple.ci', 'mauvais-mot-de-passe');
    expect(await screen.findByRole('alert')).toHaveTextContent('Identifiant ou mot de passe incorrect.');
    expect(screen.getByLabelText(/Mot de passe/, { selector: 'input' })).toHaveValue('');
  });

  it('indique la durée restante quand le compte est verrouillé (423)', async () => {
    serveur.use(
      http.post('*/v1/auth/connexion', () =>
        probleme(423, 'COMPTE_VERROUILLE', 'Compte verrouillé', { 'Retry-After': '900' }),
      ),
    );
    const { utilisateur: u } = rendreConsole('/connexion');
    await saisirIdentifiants(u, '0701020304', 'motdepasse-solide');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Votre compte est verrouillé. Réessayez dans 15 minutes.',
    );
  });

  it('refuse un téléphone invalide sans appeler l’API', async () => {
    const { utilisateur: u } = rendreConsole('/connexion');
    await saisirIdentifiants(u, '12', 'motdepasse-solide');
    expect(await screen.findByText('Numéro de téléphone invalide')).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/connexion')).toHaveLength(0);
  });

  it('propose le choix d’association quand l’utilisateur a plusieurs accès', async () => {
    const u2 = utilisateur({
      associations: [
        { associationId: 'a', associationNom: 'Mutuelle de Bécédi' },
        { associationId: 'b', associationNom: 'Association des ressortissants de Gagnoa' },
      ],
    });
    const s = session(u2, null);
    serveur.use(
      http.post('*/v1/auth/connexion', () => {
        etatServeur.sessionCookie = s;
        return HttpResponse.json(s);
      }),
    );
    const { utilisateur: u } = rendreConsole('/connexion');
    await saisirIdentifiants(u, '0701020304', 'motdepasse-solide');
    await u.click(await screen.findByRole('button', { name: /ressortissants de Gagnoa/ }));
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/contexte')[0]?.corps).toEqual({ associationId: 'b' });
    await waitFor(() =>
      expect(screen.getByText('Association des ressortissants de Gagnoa')).toBeInTheDocument(),
    );
  });

  it('impose l’activation TOTP avec le jeton intermédiaire, puis ouvre la session renvoyée', async () => {
    const s = session();
    const avecJeton = (request: Request) =>
      request.headers.get('Authorization') === 'Bearer jeton-activation';
    serveur.use(
      http.post('*/v1/auth/connexion', () =>
        HttpResponse.json({ etape: 'totp_activation', jetonIntermediaire: 'jeton-activation' }),
      ),
      http.post('*/v1/auth/totp/activation', ({ request }) =>
        avecJeton(request)
          ? HttpResponse.json({
              secret: 'JBSWY3DPEHPK3PXP',
              otpauthUrl: 'otpauth://totp/AssoFlow:awa?secret=JBSWY3DPEHPK3PXP',
            })
          : probleme(401, 'NON_AUTHENTIFIE'),
      ),
      http.post('*/v1/auth/totp/confirmation', async ({ request }) => {
        if (!avecJeton(request)) return probleme(401, 'NON_AUTHENTIFIE');
        const { code } = (await request.json()) as { code: string };
        if (code !== '654321') {
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'VALIDATION',
              status: 422,
              code: 'VALIDATION',
              detail: 'Code incorrect',
              erreurs: [{ champ: 'code', code: 'TOTP_INVALIDE', message: 'Code incorrect' }],
            },
            { status: 422, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        etatServeur.sessionCookie = s;
        return HttpResponse.json({
          codesSecours: Array.from({ length: 10 }, (_, i) => `CODE-${i}`),
          session: s,
        });
      }),
    );
    const { utilisateur: u, routeur } = rendreConsole('/connexion');
    await saisirIdentifiants(u, '0701020304', 'motdepasse-solide');

    expect(
      await screen.findByRole('heading', { name: 'Activer la vérification en deux étapes' }),
    ).toBeInTheDocument();
    expect(routeur.state.location.pathname).toBe('/connexion');
    expect(await screen.findByTestId('secret-totp')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();

    await u.type(screen.getByLabelText(/Code à 6 chiffres/), '123456');
    await u.click(screen.getByRole('button', { name: 'Activer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Code incorrect/);

    await u.type(screen.getByLabelText(/Code à 6 chiffres/), '654321');
    await u.click(screen.getByRole('button', { name: 'Activer' }));
    expect(await screen.findByText('CODE-9')).toBeInTheDocument();
    // Aucun appel avec l'access token tant que les codes n'ont pas été conservés.
    expect(requetesVers('GET', '/v1/auth/moi')).toHaveLength(0);
    const acceder = screen.getByRole('button', { name: 'Accéder à la console' });
    expect(acceder).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Télécharger (.txt)' })).toBeInTheDocument();
    await u.click(screen.getByLabelText('J’ai conservé mes codes de secours'));
    await u.click(acceder);
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/refresh')).toHaveLength(1); // reprise au chargement seulement
  });

  it('revient au formulaire si le jeton intermédiaire a expiré', async () => {
    serveur.use(
      http.post('*/v1/auth/connexion', () =>
        HttpResponse.json({ etape: 'totp_activation', jetonIntermediaire: 'jeton-perime' }),
      ),
      http.post('*/v1/auth/totp/activation', () => probleme(401, 'JETON_EXPIRE')),
    );
    const { utilisateur: u } = rendreConsole('/connexion');
    await saisirIdentifiants(u, '0701020304', 'motdepasse-solide');
    expect(await screen.findByText(/délai de vérification est dépassé/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
    expect(requetesVers('POST', '/v1/auth/refresh')).toHaveLength(1); // pas de refresh sur le jeton intermédiaire
  });
});

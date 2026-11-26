import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { getRoles } from './generated/acces-et-roles/acces-et-roles';
import { getAuthMoi } from './generated/authentification/authentification';
import { ErreurApi } from './erreurs';
import { definirJeton, ecouterSession, lireJeton } from './jeton';
import { session } from '../test/donnees';
import { etatServeur, probleme, requetesVers, serveur } from '../test/serveur';

/** Les routes protégées répondent JETON_EXPIRE tant que le jeton n'est pas celui de la session rafraîchie. */
function exigerJeton(attendu: () => string | undefined) {
  return ({ request }: { request: Request }) =>
    request.headers.get('Authorization') === `Bearer ${attendu()}`
      ? undefined
      : probleme(401, 'JETON_EXPIRE');
}

describe('client API (mutator orval)', () => {
  it('ajoute le Bearer en mémoire, les cookies et l’en-tête console', async () => {
    definirJeton('jeton-A');
    await getRoles();
    const [requete] = requetesVers('GET', '/v1/roles');
    expect(requete?.entetes.get('Authorization')).toBe('Bearer jeton-A');
    expect(requete?.entetes.get('X-Requested-With')).toBe('assoflow-console');
  });

  it('convertit un application/problem+json en ErreurApi', async () => {
    serveur.use(http.get('*/v1/roles', () => probleme(403, 'PERMISSION_REFUSEE', 'Permission refusée')));
    definirJeton('jeton-A');
    const erreur = await getRoles().catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ErreurApi);
    expect((erreur as ErreurApi).code).toBe('PERMISSION_REFUSEE');
    expect((erreur as ErreurApi).message).toBe('Permission refusée');
  });

  it('sur 401 JETON_EXPIRE, rafraîchit une seule fois pour des requêtes concurrentes puis les rejoue', async () => {
    const nouvelle = session();
    etatServeur.sessionCookie = nouvelle;
    serveur.use(
      http.get(
        '*/v1/roles',
        exigerJeton(() => nouvelle.accessToken),
      ),
      http.get(
        '*/v1/permissions',
        exigerJeton(() => nouvelle.accessToken),
      ),
      http.get(
        '*/v1/auth/moi',
        exigerJeton(() => nouvelle.accessToken),
      ),
    );
    definirJeton('jeton-expire');
    const ouvertures: string[] = [];
    const arreter = ecouterSession((e) => e.type === 'ouverte' && ouvertures.push(e.session.accessToken));

    const [roles, moi] = await Promise.all([getRoles(), getAuthMoi()]);
    arreter();

    expect(roles.length).toBeGreaterThan(0);
    expect(moi.nom).toBe('Koné');
    expect(requetesVers('POST', '/v1/auth/refresh')).toHaveLength(1);
    expect(requetesVers('POST', '/v1/auth/refresh')[0]?.entetes.get('X-Requested-With')).toBe(
      'assoflow-console',
    );
    expect(requetesVers('GET', '/v1/roles')).toHaveLength(2);
    expect(lireJeton()).toBe(nouvelle.accessToken);
    expect(ouvertures).toEqual([nouvelle.accessToken]);
  });

  it('si le refresh échoue, efface le jeton et signale la perte de session', async () => {
    serveur.use(http.get('*/v1/roles', () => probleme(401, 'JETON_EXPIRE')));
    definirJeton('jeton-expire');
    const evenements: string[] = [];
    const arreter = ecouterSession((e) => evenements.push(e.type));
    await expect(getRoles()).rejects.toBeInstanceOf(ErreurApi);
    arreter();
    expect(evenements).toEqual(['perdue']);
    expect(lireJeton()).toBeUndefined();
  });

  it('ne tente pas de refresh sur un 401 métier de connexion', async () => {
    const { postAuthConnexion } = await import('./generated/authentification/authentification');
    await expect(
      postAuthConnexion({ identifiant: '+2250701020304', motDePasse: 'x', canal: 'console' }),
    ).rejects.toMatchObject({ code: 'IDENTIFIANTS_INVALIDES' });
    expect(requetesVers('POST', '/v1/auth/refresh')).toHaveLength(0);
  });

  it('appelle les routes de santé hors préfixe /v1', async () => {
    serveur.use(http.get('*/health/ready', () => HttpResponse.json({ statut: 'ok' })));
    const { getHealthReady } = await import('./generated/sante/sante');
    await expect(getHealthReady()).resolves.toEqual({ statut: 'ok' });
  });
});

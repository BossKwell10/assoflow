import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import type { Acces, Session } from '../api/generated/modeles';
import { acces, PERMISSIONS_API, ROLES } from './donnees';

/** Réponse Problem Details conforme à docs/07 §4. */
export function probleme(status: number, code: string, detail?: string, entetes?: Record<string, string>) {
  return HttpResponse.json(
    {
      type: `https://docs.assoflow.ci/erreurs/${code}`,
      title: code,
      status,
      code,
      ...(detail ? { detail } : {}),
    },
    { status, headers: { 'content-type': 'application/problem+json', ...entetes } },
  );
}

/** État simulé du backend, réinitialisé entre les tests. */
export const etatServeur: {
  /** Session rendue par `POST /auth/refresh` (cookie HttpOnly valide) ; absente = pas de cookie. */
  sessionCookie?: Session;
  acces: Acces[];
  requetes: { methode: string; chemin: string; entetes: Headers; corps?: unknown }[];
} = { acces: [], requetes: [] };

export function reinitialiserServeur() {
  etatServeur.sessionCookie = undefined;
  etatServeur.requetes = [];
  etatServeur.acces = [
    acces({ nom: 'Koné', prenoms: 'Awa', role: ROLES[0] }),
    acces({ nom: 'Yao', prenoms: 'Koffi', role: ROLES[1] }),
    acces({
      nom: 'Traoré',
      prenoms: 'Mariam',
      role: ROLES[2],
      user: {
        id: 'u-mariam',
        telephone: '+2250506070809',
        nom: 'Traoré',
        prenoms: 'Mariam',
        derniereConnexion: null,
        verrouille: true,
      },
    }),
  ];
}

const API = '*/v1';
const json = (corps: JsonBodyType, status = 200) => HttpResponse.json(corps, { status });
const authentifie = (request: Request) => request.headers.get('Authorization')?.startsWith('Bearer ');

/** Trace chaque requête (méthode, chemin, en-têtes, corps JSON) pour les assertions. */
function tracer(request: Request) {
  const entree: (typeof etatServeur.requetes)[number] = {
    methode: request.method,
    chemin: new URL(request.url).pathname,
    entetes: new Headers(request.headers),
  };
  etatServeur.requetes.push(entree);
  void request
    .clone()
    .text()
    .then((texte) => {
      entree.corps = texte ? JSON.parse(texte) : undefined;
    })
    .catch(() => undefined);
}

/** Handlers par défaut, alignés sur docs/openapi.yaml (tags Authentification, Accès et rôles, Association). */
export const handlers = [
  http.get('*/health/ready', () => json({ statut: 'ok', dependances: { postgres: 'ok' } })),

  http.post(`${API}/auth/refresh`, ({ request }) => {
    if (request.headers.get('X-Requested-With') !== 'assoflow-console')
      return probleme(401, 'NON_AUTHENTIFIE');
    return etatServeur.sessionCookie ? json(etatServeur.sessionCookie) : probleme(401, 'NON_AUTHENTIFIE');
  }),
  http.get(`${API}/auth/moi`, ({ request }) =>
    authentifie(request) && etatServeur.sessionCookie
      ? json(etatServeur.sessionCookie.utilisateur)
      : probleme(401, 'NON_AUTHENTIFIE'),
  ),
  http.post(`${API}/auth/deconnexion`, () => {
    etatServeur.sessionCookie = undefined;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/auth/contexte`, async ({ request }) => {
    const { associationId } = (await request.json()) as { associationId: string };
    const s = etatServeur.sessionCookie;
    if (!s) return probleme(401, 'NON_AUTHENTIFIE');
    const { jetonFactice } = await import('./donnees');
    const nouvelle = { ...s, accessToken: jetonFactice({ aid: associationId }) };
    etatServeur.sessionCookie = nouvelle;
    return json(nouvelle);
  }),
  http.post(`${API}/auth/connexion`, () => probleme(401, 'IDENTIFIANTS_INVALIDES', 'Identifiants invalides')),

  http.get(`${API}/exercices`, () =>
    json([{ id: 'e1', libelle: '2027', dateDebut: '2027-01-01', dateFin: '2027-12-31', statut: 'ouvert' }]),
  ),
  http.get(`${API}/acces`, () => json({ donnees: etatServeur.acces, page: { curseurSuivant: null } })),
  http.post(`${API}/acces`, async ({ request }) => {
    const corps = (await request.json()) as {
      nom: string;
      prenoms: string;
      telephone: string;
      roleId: string;
    };
    const cree = acces({
      nom: corps.nom,
      prenoms: corps.prenoms,
      role: ROLES.find((r) => r.id === corps.roleId),
    });
    etatServeur.acces = [...etatServeur.acces, cree];
    return json(cree, 201);
  }),
  http.post(`${API}/acces/:id/revoquer`, async ({ params, request }) => {
    const { motif } = (await request.json()) as { motif?: string };
    if (!motif || motif.length < 3) return probleme(422, 'VALIDATION', 'Motif obligatoire');
    const cible = etatServeur.acces.find((a) => a.id === params.id);
    if (!cible) return probleme(404, 'INTROUVABLE');
    cible.statut = 'revoque';
    return json(cible);
  }),
  http.post(`${API}/acces/:id/deverrouiller`, ({ params }) => {
    const cible = etatServeur.acces.find((a) => a.id === params.id);
    if (!cible?.user) return probleme(404, 'INTROUVABLE');
    cible.user.verrouille = false;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/roles`, () => json(ROLES)),
  http.get(`${API}/permissions`, () => json(PERMISSIONS_API)),
];

export const serveur = setupServer(...handlers);
serveur.events.on('request:start', ({ request }) => tracer(request));

/** Requêtes reçues pour une méthode et un chemin (`/v1/...`). */
export const requetesVers = (methode: string, chemin: string | RegExp) =>
  etatServeur.requetes.filter(
    (r) =>
      r.methode === methode && (typeof chemin === 'string' ? r.chemin === chemin : chemin.test(r.chemin)),
  );

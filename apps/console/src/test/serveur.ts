import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import type {
  Acces,
  MembreCreation,
  Association,
  AyantDroit,
  CategorieDepense,
  CategorieMembre,
  Exercice,
  Famille,
  Membre,
  Session,
} from '../api/generated/modeles';
import {
  acces,
  ASSOCIATION,
  CATEGORIES_MEMBRES,
  FAMILLES,
  membre,
  membresParDefaut,
  PERMISSIONS_API,
  ROLES,
} from './donnees';
import { EXERCICE_OUVERT_ID, handlersSprint3, reinitialiserS3 } from './serveurSprint3';
import { handlersSprint4, reinitialiserS4 } from './serveurSprint4';

/** Réponse Problem Details conforme à docs/07 §4. */
export function probleme(
  status: number,
  code: string,
  detail?: string,
  entetes?: Record<string, string>,
  erreurs?: { champ: string; message: string; ref?: string | null }[],
) {
  return HttpResponse.json(
    {
      type: `https://docs.assoflow.ci/erreurs/${code}`,
      title: code,
      status,
      code,
      ...(detail ? { detail } : {}),
      ...(erreurs ? { erreurs } : {}),
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
  membres: Membre[];
  /** Version de chaque membre (ETag `"v<n>"`), incrémentée à chaque écriture. */
  versions: Map<string, number>;
  ayantsDroit: Map<string, AyantDroit[]>;
  familles: Famille[];
  categoriesMembres: CategorieMembre[];
  categoriesDepense: CategorieDepense[];
  exercices: Exercice[];
  association: Association;
  versionAssociation: number;
  /** RG-EXE-003 : des dépenses soumises ou validées bloquent la clôture. */
  depensesEnCours: boolean;
} = {
  acces: [],
  requetes: [],
  membres: [],
  versions: new Map(),
  ayantsDroit: new Map(),
  familles: [],
  categoriesMembres: [],
  categoriesDepense: [],
  exercices: [],
  association: ASSOCIATION,
  versionAssociation: 1,
  depensesEnCours: false,
};

export function reinitialiserServeur() {
  reinitialiserS3();
  reinitialiserS4();
  etatServeur.sessionCookie = undefined;
  etatServeur.requetes = [];
  etatServeur.membres = membresParDefaut();
  etatServeur.versions = new Map(etatServeur.membres.map((m) => [m.id, 1]));
  etatServeur.ayantsDroit = new Map([
    [
      etatServeur.membres[0]!.id,
      [{ id: 'ad-1', nom: 'Kouassi', prenoms: 'Marie', lien: 'conjoint', dateNaissance: '1990-04-12' }],
    ],
  ]);
  etatServeur.familles = FAMILLES.map((f) => ({ ...f }));
  etatServeur.categoriesMembres = CATEGORIES_MEMBRES.map((c) => ({ ...c }));
  etatServeur.categoriesDepense = [
    { id: 'cd-1', nature: 'fonctionnement', libelle: 'Fonctionnement', actif: true },
    { id: 'cd-2', nature: 'aide_sociale', libelle: 'Aide sociale', actif: true },
  ];
  etatServeur.exercices = [
    {
      id: '0190a1b2-0000-7000-8000-0000000000e0',
      libelle: '2026',
      dateDebut: '2026-01-01',
      dateFin: '2026-12-31',
      statut: 'cloture',
      clotureAt: '2027-01-10T09:00:00Z',
    },
    {
      id: EXERCICE_OUVERT_ID,
      libelle: '2027',
      dateDebut: '2027-01-01',
      dateFin: '2027-12-31',
      statut: 'ouvert',
      clotureAt: null,
    },
  ];
  etatServeur.association = { ...ASSOCIATION };
  etatServeur.versionAssociation = 1;
  etatServeur.depensesEnCours = false;
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
  ...handlersSprint3(),
  ...handlersSprint4(),
  ...handlersSprint2(),
];

/** Handlers des tags Association et Membres (docs/openapi.yaml), avec ETag / If-Match (docs/07 §5). */
function handlersSprint2() {
  const etag = (version: number) => `"v${version}"`;
  const introuvable = () => probleme(404, 'INTROUVABLE', 'Ressource introuvable');
  const trouver = (id: unknown) => etatServeur.membres.find((m) => m.id === id);
  /** Membre avec son ETag (en-tête et champ `etag`, contrat 84498fd). */
  const avecEtag = (m: Membre, status = 200) => {
    const version = etag(etatServeur.versions.get(m.id) ?? 1);
    return HttpResponse.json({ ...m, etag: version }, { status, headers: { ETag: version } });
  };
  const ecrire = (m: Membre, maj: Partial<Membre>) => {
    Object.assign(m, maj, { updatedAt: new Date().toISOString() });
    etatServeur.versions.set(m.id, (etatServeur.versions.get(m.id) ?? 1) + 1);
    return avecEtag(m);
  };
  /** docs/07 §5 : If-Match obligatoire depuis la console (428), 412 s'il ne correspond plus. */
  const controlerVersion = (request: Request, attendu: string) => {
    const ifMatch = request.headers.get('If-Match');
    if (!ifMatch) return probleme(428, 'PRECONDITION_REQUISE', 'En-tête If-Match obligatoire');
    if (ifMatch !== '*' && ifMatch !== attendu)
      return probleme(412, 'PRECONDITION_ECHOUEE', 'La ressource a été modifiée depuis sa lecture');
    return undefined;
  };
  const motifValide = async (request: Request) => {
    const { motif } = (await request.json()) as { motif?: string };
    return motif && motif.length >= 3 ? motif : undefined;
  };
  const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  return [
    // --- Association
    http.get(`${API}/association`, () => {
      const version = etag(etatServeur.versionAssociation);
      return HttpResponse.json({ ...etatServeur.association, etag: version }, { headers: { ETag: version } });
    }),
    http.patch(`${API}/association`, async ({ request }) => {
      const refus = controlerVersion(request, etag(etatServeur.versionAssociation));
      if (refus) return refus;
      Object.assign(etatServeur.association, await request.json());
      etatServeur.versionAssociation += 1;
      const version = etag(etatServeur.versionAssociation);
      return HttpResponse.json({ ...etatServeur.association, etag: version }, { headers: { ETag: version } });
    }),
    http.put(`${API}/association/logo`, () =>
      json({ ...etatServeur.association, logoUrl: 'https://cdn/logo.png' }),
    ),
    http.get(`${API}/exercices`, () => json(etatServeur.exercices)),
    http.post(`${API}/exercices`, async ({ request }) => {
      const corps = (await request.json()) as Exercice;
      const cree = {
        ...corps,
        id: `e${etatServeur.exercices.length + 1}`,
        statut: 'ouvert' as const,
        clotureAt: null,
      };
      etatServeur.exercices.push(cree);
      return json(cree, 201);
    }),
    http.post(`${API}/exercices/:id/cloturer`, ({ params }) => {
      const e = etatServeur.exercices.find((x) => x.id === params.id);
      if (!e) return introuvable();
      if (e.statut === 'cloture') return probleme(409, 'ETAT_INCOMPATIBLE', 'Exercice déjà clôturé');
      if (etatServeur.depensesEnCours)
        return probleme(
          422,
          'DEPENSES_EN_COURS',
          '2 dépenses soumises ou validées sont datées dans l’exercice 2027.',
        );
      Object.assign(e, { statut: 'cloture', clotureAt: '2027-12-31T18:00:00Z' });
      return json(e);
    }),

    // --- Catégories
    http.get(`${API}/categories-membres`, () => json(etatServeur.categoriesMembres)),
    http.post(`${API}/categories-membres`, async ({ request }) => {
      const c = { ...((await request.json()) as CategorieMembre), id: crypto.randomUUID() };
      etatServeur.categoriesMembres.push(c);
      return json(c, 201);
    }),
    http.patch(`${API}/categories-membres/:id`, async ({ params, request }) => {
      const c = etatServeur.categoriesMembres.find((x) => x.id === params.id);
      if (!c) return introuvable();
      return json(Object.assign(c, await request.json()));
    }),
    http.get(`${API}/categories-depense`, () => json(etatServeur.categoriesDepense)),
    http.post(`${API}/categories-depense`, async ({ request }) => {
      const c = { ...((await request.json()) as CategorieDepense), id: crypto.randomUUID() };
      etatServeur.categoriesDepense.push(c);
      return json(c, 201);
    }),
    http.patch(`${API}/categories-depense/:id`, async ({ params, request }) => {
      const c = etatServeur.categoriesDepense.find((x) => x.id === params.id);
      if (!c) return introuvable();
      return json(Object.assign(c, await request.json()));
    }),

    // --- Familles
    http.get(`${API}/familles`, ({ request }) => {
      const q = sansAccents(new URL(request.url).searchParams.get('q') ?? '');
      const donnees = etatServeur.familles.filter((f) => !q || sansAccents(f.nom).includes(q));
      return json({ donnees, page: { curseurSuivant: null } });
    }),
    http.post(`${API}/familles`, async ({ request }) => {
      const f = { ...((await request.json()) as Famille), nombreMembres: 0 };
      etatServeur.familles.push(f);
      return json(f, 201);
    }),
    http.patch(`${API}/familles/:id`, async ({ params, request }) => {
      const f = etatServeur.familles.find((x) => x.id === params.id);
      if (!f) return introuvable();
      return json(Object.assign(f, await request.json()));
    }),
    http.get(`${API}/familles/:id/membres`, ({ params }) =>
      json(etatServeur.membres.filter((m) => m.familleId === params.id)),
    ),

    // --- Membres
    http.get(`${API}/membres`, ({ request }) => {
      const p = new URL(request.url).searchParams;
      const q = sansAccents(p.get('q') ?? '');
      let liste = etatServeur.membres.filter(
        (m) =>
          (!q || sansAccents(`${m.nom} ${m.prenoms} ${m.numero} ${m.telephone ?? ''}`).includes(q)) &&
          (p.get('etat') ? m.etat === p.get('etat') : m.etat !== 'desactive') &&
          (!p.get('statutAdhesion') || m.statutAdhesion === p.get('statutAdhesion')) &&
          (!p.get('categorieId') || m.categorieId === p.get('categorieId')) &&
          (!p.get('familleId') || m.familleId === p.get('familleId')) &&
          (p.get('diaspora') !== 'true' || m.estDiaspora) &&
          (p.get('enRetard') !== 'true' || (m.soldeCotisations ?? 0) < 0),
      );
      const tri = p.get('tri');
      if (tri === 'nom' || tri === '-nom') {
        liste = [...liste].sort((a, b) => `${a.nom}${a.prenoms}`.localeCompare(`${b.nom}${b.prenoms}`));
        if (tri === '-nom') liste.reverse();
      }
      const limite = Number(p.get('limite') ?? 50);
      const debut = Number(p.get('curseur') ?? 0);
      const fin = debut + limite;
      return json({
        donnees: liste.slice(debut, fin),
        page: { curseurSuivant: fin < liste.length ? String(fin) : null },
      });
    }),
    http.post(`${API}/membres`, async ({ request }) => {
      const { consentement, confirmationDoublon, ...corps } = (await request.json()) as MembreCreation;
      const existant = trouver(corps.id);
      // Rejeu idempotent (docs/07 §5) : même id → 200 et la fiche existante.
      if (existant) return avecEtag(existant);
      if (consentement?.traitementDonnees !== true)
        return probleme(422, 'VALIDATION', 'Données invalides', undefined, [
          { champ: 'consentement', message: 'Le consentement est obligatoire' },
        ]);
      const doublon = etatServeur.membres.find(
        (m) =>
          sansAccents(`${m.nom} ${m.prenoms}`) === sansAccents(`${corps.nom} ${corps.prenoms}`) &&
          (m.telephone ?? null) === (corps.telephone ?? null),
      );
      // RG-MBR-003 : doublon probable non confirmé → 422 CONFIRMATION_REQUISE, `ref` = fiche existante.
      if (doublon && !confirmationDoublon)
        return probleme(422, 'CONFIRMATION_REQUISE', 'Un membre identique existe peut-être déjà', undefined, [
          { champ: 'nom', message: 'Doublon probable', ref: doublon.id },
        ]);
      const cree = membre({
        ...corps,
        doublonProbable: Boolean(doublon),
        doublonDe: doublon?.id ?? null,
        numero: `MBR-${String(etatServeur.membres.length + 100).padStart(6, '0')}`,
      });
      etatServeur.membres.push(cree);
      etatServeur.versions.set(cree.id, 1);
      return avecEtag(cree, 201);
    }),
    http.get(`${API}/membres/doublons`, () => json(etatServeur.membres.filter((m) => m.doublonProbable))),
    http.post(`${API}/membres/:id/doublon`, ({ params }) => {
      const m = trouver(params.id);
      return m ? ecrire(m, { doublonProbable: false, doublonDe: null }) : introuvable();
    }),
    http.get(`${API}/membres/:id`, ({ params }) => {
      const m = trouver(params.id);
      return m ? avecEtag(m) : introuvable();
    }),
    http.patch(`${API}/membres/:id`, async ({ params, request }) => {
      const m = trouver(params.id);
      if (!m) return introuvable();
      const refus = controlerVersion(request, etag(etatServeur.versions.get(m.id) ?? 1));
      if (refus) return refus;
      return ecrire(m, (await request.json()) as Partial<Membre>);
    }),
    http.put(`${API}/membres/:id/photo`, ({ params }) => {
      const m = trouver(params.id);
      return m ? ecrire(m, { photoUrl: 'https://cdn/photo.jpg' }) : introuvable();
    }),
    ...(['suspendre', 'desactiver', 'anonymiser'] as const).map((action) =>
      http.post(`${API}/membres/:id/${action}`, async ({ params, request }) => {
        const m = trouver(params.id);
        if (!m) return introuvable();
        const motif = await motifValide(request);
        if (!motif) return probleme(422, 'VALIDATION', 'Motif obligatoire');
        if (action === 'anonymiser')
          return ecrire(m, {
            nom: 'Anonyme',
            prenoms: m.numero ?? '',
            telephone: null,
            email: null,
            dateNaissance: null,
            anonymise: true,
          });
        return ecrire(m, { etat: action === 'suspendre' ? 'suspendu' : 'desactive', motifEtat: motif });
      }),
    ),
    http.post(`${API}/membres/:id/reactiver`, ({ params }) => {
      const m = trouver(params.id);
      return m ? ecrire(m, { etat: 'actif', motifEtat: null }) : introuvable();
    }),
    http.get(`${API}/membres/:id/situation`, ({ params }) => {
      const m = trouver(params.id);
      if (!m) return introuvable();
      const du = Math.max(0, -(m.soldeCotisations ?? 0));
      return json({
        membreId: m.id,
        totalExigible: 60000,
        totalPaye: 60000 - du,
        resteDu: du,
        avance: 0,
        echeancesEnRetard: du ? 3 : 0,
        prochaineEcheance: null,
      });
    }),
    http.get(`${API}/membres/:id/historique`, () =>
      json({
        donnees: [
          { date: '2026-01-15T10:00:00Z', type: 'statut', libelle: 'Adhésion', montant: null, refId: null },
        ],
        page: { curseurSuivant: null },
      }),
    ),
    http.get(`${API}/membres/:id/ayants-droit`, ({ params }) =>
      json(etatServeur.ayantsDroit.get(String(params.id)) ?? []),
    ),
    http.post(`${API}/membres/:id/ayants-droit`, async ({ params, request }) => {
      const a = (await request.json()) as AyantDroit;
      const liste = etatServeur.ayantsDroit.get(String(params.id)) ?? [];
      etatServeur.ayantsDroit.set(String(params.id), [...liste, a]);
      return json(a, 201);
    }),
    http.patch(`${API}/membres/:id/ayants-droit/:ayantDroitId`, async ({ params, request }) => {
      const a = (etatServeur.ayantsDroit.get(String(params.id)) ?? []).find(
        (x) => x.id === params.ayantDroitId,
      );
      if (!a) return introuvable();
      return json(Object.assign(a, await request.json()));
    }),
    http.delete(`${API}/membres/:id/ayants-droit/:ayantDroitId`, ({ params }) => {
      const liste = etatServeur.ayantsDroit.get(String(params.id)) ?? [];
      etatServeur.ayantsDroit.set(
        String(params.id),
        liste.filter((x) => x.id !== params.ayantDroitId),
      );
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

export const serveur = setupServer(...handlers);
serveur.events.on('request:start', ({ request }) => tracer(request));

/** Requêtes reçues pour une méthode et un chemin (`/v1/...`). */
export const requetesVers = (methode: string, chemin: string | RegExp) =>
  etatServeur.requetes.filter(
    (r) =>
      r.methode === methode && (typeof chemin === 'string' ? r.chemin === chemin : chemin.test(r.chemin)),
  );

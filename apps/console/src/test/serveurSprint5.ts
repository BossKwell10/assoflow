import { http, HttpResponse, type JsonBodyType } from 'msw';
import type { Appareil, RejetSync } from '../api/generated/modeles';

/** Handlers du sprint 5 (appareils, rejets de synchronisation), alignés sur docs/openapi.yaml. */
export const etatS5: { appareils: Appareil[]; rejets: RejetSync[] } = { appareils: [], rejets: [] };

export const APPAREIL_TRESORIER_ID = '0190a1b2-0000-7000-8000-0000000d0001';
export const APPAREIL_REVOQUE_ID = '0190a1b2-0000-7000-8000-0000000d0002';
export const APPAREIL_SECRETAIRE_ID = '0190a1b2-0000-7000-8000-0000000d0003';

export function reinitialiserS5() {
  etatS5.appareils = [
    {
      id: APPAREIL_TRESORIER_ID,
      nom: 'Tecno Spark 10',
      plateforme: 'android',
      versionApp: '1.2.0',
      prefixeRecu: 'A01',
      utilisateur: { id: 'u-2', nom: 'Koffi Yao' },
      derniereSync: '2027-03-05T09:14:00Z',
      elementsEnAttente: 3,
      rejetsNonAcquittes: 2,
      revoqueAt: null,
      purgeDemandee: false,
      createdAt: '2027-01-10T08:00:00Z',
    },
    {
      id: APPAREIL_SECRETAIRE_ID,
      nom: 'iPhone SE',
      plateforme: 'ios',
      versionApp: '1.1.0',
      prefixeRecu: 'A02',
      utilisateur: { id: 'u-3', nom: 'Aya Kouassi' },
      derniereSync: null,
      elementsEnAttente: null,
      rejetsNonAcquittes: 0,
      revoqueAt: null,
      purgeDemandee: false,
      createdAt: '2027-02-01T08:00:00Z',
    },
    {
      id: APPAREIL_REVOQUE_ID,
      nom: 'Ancien Itel',
      plateforme: 'android',
      versionApp: '1.0.0',
      prefixeRecu: 'A00',
      utilisateur: { id: 'u-2', nom: 'Koffi Yao' },
      derniereSync: '2026-12-01T10:00:00Z',
      elementsEnAttente: 0,
      rejetsNonAcquittes: 0,
      revoqueAt: '2027-01-09T12:00:00Z',
      purgeDemandee: true,
      createdAt: '2026-11-01T08:00:00Z',
    },
  ];
  etatS5.rejets = [
    {
      id: 'rj-1',
      table: 'paiements',
      elementId: '0193a1b2-0000-7000-8000-0000000e0001',
      code: 'EXERCICE_FERME',
      message: 'Aucun exercice ouvert au 12/01/2026',
      createdAt: '2027-03-05T09:14:01Z',
      appareilId: APPAREIL_TRESORIER_ID,
      appareilNom: 'Tecno Spark 10',
      acquitteAt: null,
    },
    {
      id: 'rj-2',
      table: 'membres',
      elementId: '0193a1b2-0000-7000-8000-0000000e0002',
      code: 'VALIDATION',
      message: 'Téléphone au format international attendu',
      createdAt: '2027-03-05T09:14:02Z',
      appareilId: APPAREIL_TRESORIER_ID,
      appareilNom: 'Tecno Spark 10',
      acquitteAt: null,
    },
    {
      id: 'rj-3',
      table: 'paiements',
      elementId: '0193a1b2-0000-7000-8000-0000000e0003',
      code: 'REFERENCE_INVALIDE',
      message: 'Membre introuvable',
      createdAt: '2027-02-01T09:00:00Z',
      appareilId: APPAREIL_SECRETAIRE_ID,
      appareilNom: 'iPhone SE',
      acquitteAt: '2027-02-02T09:00:00Z',
    },
  ];
}

const API = '*/v1';
const json = (corps: JsonBodyType, status = 200) => HttpResponse.json(corps, { status });
const probleme = (status: number, code: string, detail: string) =>
  HttpResponse.json(
    { type: `https://docs.assoflow.ci/erreurs/${code}`, title: code, status, code, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export function handlersSprint5() {
  return [
    http.get(`${API}/appareils`, () => json(etatS5.appareils)),
    http.post(`${API}/appareils/:id/revoquer`, async ({ params, request }) => {
      const corps = (await request.json()) as { motif?: string; purger?: boolean };
      if (!corps.motif || corps.motif.trim().length < 3)
        return probleme(422, 'VALIDATION', 'Motif obligatoire');
      const a = etatS5.appareils.find((x) => x.id === params.id);
      if (!a) return probleme(404, 'INTROUVABLE', 'Appareil introuvable');
      if (a.revoqueAt) return probleme(409, 'ETAT_INCOMPATIBLE', 'Appareil déjà révoqué');
      a.revoqueAt = '2027-03-06T10:00:00Z';
      a.purgeDemandee = corps.purger === true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/sync/rejets`, ({ request }) => {
      const url = new URL(request.url);
      const appareilId = url.searchParams.get('appareilId');
      const tous = url.searchParams.get('inclureAcquittes') === 'true';
      const donnees = etatS5.rejets
        .filter((r) => !appareilId || r.appareilId === appareilId)
        .filter((r) => tous || r.acquitteAt === null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ donnees, page: { curseurSuivant: null, total: null } });
    }),
  ];
}

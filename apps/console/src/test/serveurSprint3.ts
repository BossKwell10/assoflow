import { genererPeriodes } from '@assoflow/contracts';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type {
  ApercuCampagne,
  Campagne,
  CampagneCreation,
  Echeance,
  RapportImport,
  Tache,
} from '../api/generated/modeles';

/**
 * Handlers du sprint 3 (tags « Cotisations », import et carte des « Membres », tâches), alignés sur
 * docs/openapi.yaml. État simulé réinitialisé entre les tests.
 */
export const etatS3: {
  campagnes: Campagne[];
  versionsCampagnes: Map<string, number>;
  echeances: Echeance[];
  taches: Map<string, Tache>;
  /** Interrogations restantes avant qu'une tâche passe « terminee ». */
  attente: Map<string, number>;
  rapports: Map<string, RapportImport>;
  /** Membres ciblés par l'aperçu et l'activation. */
  membresCibles: { id: string; numero: string; nom: string }[];
  /** Rapport renvoyé par la prochaine analyse d'import. */
  prochainRapport?: Omit<RapportImport, 'tacheId' | 'confirmationId'>;
  /** Erreur de structure renvoyée par la prochaine analyse (422). */
  erreurImport?: { code: string; message: string };
} = {
  campagnes: [],
  versionsCampagnes: new Map(),
  echeances: [],
  taches: new Map(),
  attente: new Map(),
  rapports: new Map(),
  membresCibles: [],
};

export const EXERCICE_OUVERT_ID = '0190a1b2-0000-7000-8000-0000000000e1';
export const CAMPAGNE_ACTIVE_ID = '0190a1b2-0000-7000-8000-00000000ca01';
export const CAMPAGNE_BROUILLON_ID = '0190a1b2-0000-7000-8000-00000000ca02';

function echeancesDe(c: Campagne, membres: { id: string; numero: string; nom: string }[]): Echeance[] {
  return membres.flatMap((m) =>
    genererPeriodes(c).map((p, i) => ({
      id: `${c.id}-${m.id}-${p.numero}`,
      campagneId: c.id!,
      campagneLibelle: c.libelle,
      membreId: m.id,
      membreNumero: m.numero,
      membreNom: m.nom,
      numeroPeriode: p.numero,
      libellePeriode: p.libelle,
      montantDu: c.montant,
      montantPaye: i === 0 ? c.montant : 0,
      dateEcheance: p.dateEcheance,
      situation: i === 0 ? 'payee' : i === 1 ? 'en_retard' : 'a_venir',
      motifExoneration: null,
      imputee: i === 0,
    })),
  );
}

export function reinitialiserS3() {
  etatS3.membresCibles = [
    { id: 'm-1', numero: 'MBR-000001', nom: 'Jean Kouassi' },
    { id: 'm-2', numero: 'MBR-000002', nom: 'Awa Koné' },
  ];
  const active: Campagne = {
    id: CAMPAGNE_ACTIVE_ID,
    exerciceId: EXERCICE_OUVERT_ID,
    libelle: 'Cotisation mensuelle 2027',
    type: 'ordinaire',
    motif: null,
    projetId: null,
    montant: 2000,
    periodicite: 'mensuelle',
    dateDebut: '2027-01-01',
    dateFin: '2027-04-30',
    jourEcheance: 5,
    categoriesCibles: [],
    statut: 'active',
    activeeAt: '2027-01-02T08:00:00Z',
    nombrePeriodes: 4,
    tauxRecouvrement: 0.5,
    etag: '"1"',
  };
  const brouillon: Campagne = {
    ...active,
    id: CAMPAGNE_BROUILLON_ID,
    libelle: 'Décès du doyen',
    type: 'exceptionnelle',
    motif: 'deces',
    periodicite: 'unique',
    montant: 5000,
    dateFin: '2027-01-01',
    statut: 'brouillon',
    activeeAt: null,
    nombrePeriodes: 1,
    tauxRecouvrement: null,
  };
  etatS3.campagnes = [active, brouillon];
  etatS3.versionsCampagnes = new Map([
    [active.id!, 1],
    [brouillon.id!, 1],
  ]);
  etatS3.echeances = echeancesDe(active, etatS3.membresCibles);
  etatS3.taches = new Map();
  etatS3.attente = new Map();
  etatS3.rapports = new Map();
  etatS3.prochainRapport = {
    nomFichier: 'membres.csv',
    lignes: 7,
    aCreer: 4,
    doublons: 1,
    erreurs: 2,
    colonnesIgnorees: ['profession'],
    details: [
      {
        ligne: 3,
        statut: 'doublon_probable',
        nom: 'Yao Kouamé',
        message: 'Doublon probable de MBR-000001 — Jean Kouassi',
      },
      { ligne: 5, statut: 'erreur', nom: 'Ali Bamba', message: 'téléphone « 12 » invalide' },
      { ligne: 8, statut: 'erreur', nom: 'Moussa', message: 'nom manquant' },
    ],
  };
  etatS3.erreurImport = undefined;
}

const API = '*/v1';
const json = (corps: JsonBodyType, status = 200, entetes?: Record<string, string>) =>
  HttpResponse.json(corps, { status, headers: entetes });
const probleme = (
  status: number,
  code: string,
  detail: string,
  erreurs?: { champ: string; code: string; message: string }[],
) =>
  HttpResponse.json(
    {
      type: `https://docs.assoflow.ci/erreurs/${code}`,
      title: code,
      status,
      code,
      detail,
      ...(erreurs ? { erreurs } : {}),
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

let compteur = 0;
function creerTache(type: string, resultat: Record<string, unknown> | null, interrogations = 0): Tache {
  compteur++;
  const id = `0190a1b2-0000-7000-8000-${String(compteur).padStart(12, '0')}`;
  const tache: Tache = {
    id,
    type,
    statut: 'en_attente',
    progression: 0,
    erreur: null,
    resultat,
    createdAt: '2027-03-01T10:00:00Z',
    termineAt: null,
  };
  etatS3.taches.set(id, tache);
  etatS3.attente.set(id, interrogations);
  return tache;
}

const avecVersion = (c: Campagne) => ({ ...c, etag: `"${etatS3.versionsCampagnes.get(c.id!) ?? 1}"` });

function statistiques(id: string) {
  const e = etatS3.echeances.filter((x) => x.campagneId === id);
  const periodes = [...new Set(e.map((x) => x.numeroPeriode))].sort((a, b) => a - b);
  const somme = (l: Echeance[], f: (x: Echeance) => number) => l.reduce((s, x) => s + f(x), 0);
  const echues = e.filter((x) => x.situation !== 'a_venir');
  return {
    campagneId: id,
    membresCibles: new Set(e.map((x) => x.membreId)).size,
    montantAttendu: somme(e, (x) => x.montantDu),
    montantEchuAttendu: somme(echues, (x) => x.montantDu),
    montantRecouvre: somme(e, (x) => x.montantPaye),
    montantRecouvreEchu: somme(echues, (x) => x.montantPaye),
    tauxRecouvrement: echues.length
      ? somme(echues, (x) => x.montantPaye) / somme(echues, (x) => x.montantDu)
      : null,
    parPeriode: periodes.map((n) => {
      const p = e.filter((x) => x.numeroPeriode === n);
      return {
        numeroPeriode: n,
        libellePeriode: p[0]!.libellePeriode,
        dateEcheance: p[0]!.dateEcheance,
        montantAttendu: somme(p, (x) => x.montantDu),
        montantRecouvre: somme(p, (x) => x.montantPaye),
        echeancesEnRetard: p.filter((x) => x.situation === 'en_retard').length,
        echeancesPayees: p.filter((x) => x.situation === 'payee').length,
      };
    }),
  };
}

export function handlersSprint3() {
  return [
    // --- Tâches
    http.get(`${API}/taches/:id`, ({ params }) => {
      const tache = etatS3.taches.get(String(params.id));
      if (!tache) return probleme(404, 'INTROUVABLE', 'Tâche introuvable');
      const reste = etatS3.attente.get(tache.id) ?? 0;
      if (reste > 0) {
        etatS3.attente.set(tache.id, reste - 1);
        return json({ ...tache, statut: 'en_cours', progression: 40 });
      }
      if (tache.statut !== 'echec') Object.assign(tache, { statut: 'terminee', progression: 100 });
      return json(tache);
    }),

    // --- Import (A6)
    http.get(`${API}/membres/import/modele`, () =>
      HttpResponse.arrayBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer, {
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      }),
    ),
    http.post(`${API}/membres/import`, () => {
      if (etatS3.erreurImport) {
        const { code, message } = etatS3.erreurImport;
        return probleme(422, 'VALIDATION', message, [{ champ: 'fichier', code, message }]);
      }
      const tache = creerTache('import_membres_analyse', null);
      etatS3.rapports.set(tache.id, { tacheId: tache.id, confirmationId: null, ...etatS3.prochainRapport! });
      return json(tache, 202);
    }),
    http.get(`${API}/membres/import/:tacheId`, ({ params }) => {
      const r = etatS3.rapports.get(String(params.tacheId));
      if (!r) return probleme(404, 'INTROUVABLE', 'Tâche introuvable');
      return json(r);
    }),
    http.post(`${API}/membres/import/:tacheId/confirmer`, async ({ params, request }) => {
      const r = etatS3.rapports.get(String(params.tacheId));
      if (!r) return probleme(404, 'INTROUVABLE', 'Tâche introuvable');
      if (r.confirmationId) return probleme(409, 'ETAT_INCOMPATIBLE', 'Cet import a déjà été confirmé');
      const corps = (await request.json()) as {
        inclureDoublons?: boolean;
        attestationConsentement?: boolean;
      };
      if (corps.attestationConsentement !== true)
        return probleme(422, 'VALIDATION', 'Attestation obligatoire');
      const creees = r.aCreer + (corps.inclureDoublons ? r.doublons : 0);
      const tache = creerTache('import_membres_confirmer', {
        creees,
        doublonsCrees: corps.inclureDoublons ? r.doublons : 0,
        ignorees: corps.inclureDoublons ? 0 : r.doublons,
        erreurs: 1,
        famillesCreees: 1,
        details: [{ ligne: 9, statut: 'erreur', numero: null, message: 'Catégorie introuvable ou inactive' }],
      });
      r.confirmationId = tache.id;
      return json(tache, 202);
    }),
    http.get(`${API}/membres/:id/carte`, () =>
      HttpResponse.arrayBuffer(new TextEncoder().encode('%PDF-1.7').buffer, {
        headers: { 'content-type': 'application/pdf' },
      }),
    ),

    // --- Campagnes (A8, A9)
    http.get(`${API}/campagnes`, ({ request }) => {
      const url = new URL(request.url);
      const statut = url.searchParams.get('statut');
      const type = url.searchParams.get('type');
      const donnees = etatS3.campagnes
        .filter((c) => (!statut || c.statut === statut) && (!type || c.type === type))
        .map(avecVersion);
      return json({ donnees, page: { curseurSuivant: null, total: null } });
    }),
    http.post(`${API}/campagnes`, async ({ request }) => {
      const corps = (await request.json()) as CampagneCreation;
      if (corps.dateFin > '2027-12-31')
        return probleme(
          422,
          'VALIDATION',
          'Les dates de la campagne doivent rester dans l’exercice « 2027 »',
          [
            {
              champ: 'dateFin',
              code: 'HORS_EXERCICE',
              message: 'Les dates de la campagne doivent rester dans l’exercice « 2027 »',
            },
          ],
        );
      const c: Campagne = {
        ...corps,
        id: `0190a1b2-0000-7000-8000-0000000c${String(etatS3.campagnes.length).padStart(4, '0')}`,
        motif: corps.motif ?? null,
        projetId: null,
        jourEcheance: corps.jourEcheance ?? 5,
        categoriesCibles: corps.categoriesCibles ?? [],
        statut: 'brouillon',
        activeeAt: null,
        nombrePeriodes: genererPeriodes(corps).length,
        tauxRecouvrement: null,
      };
      etatS3.campagnes.push(c);
      etatS3.versionsCampagnes.set(c.id!, 1);
      return json(avecVersion(c), 201, { ETag: '"1"' });
    }),
    http.get(`${API}/campagnes/:id`, ({ params }) => {
      const c = etatS3.campagnes.find((x) => x.id === params.id);
      if (!c) return probleme(404, 'INTROUVABLE', 'Campagne introuvable');
      return json(avecVersion(c), 200, { ETag: avecVersion(c).etag! });
    }),
    http.patch(`${API}/campagnes/:id`, async ({ params, request }) => {
      const c = etatS3.campagnes.find((x) => x.id === params.id);
      if (!c) return probleme(404, 'INTROUVABLE', 'Campagne introuvable');
      const ifMatch = request.headers.get('If-Match');
      if (!ifMatch) return probleme(428, 'PRECONDITION_REQUISE', 'En-tête If-Match obligatoire');
      if (ifMatch !== avecVersion(c).etag) return probleme(412, 'PRECONDITION_ECHOUEE', 'Version périmée');
      Object.assign(c, await request.json());
      Object.assign(c, { nombrePeriodes: genererPeriodes(c).length });
      etatS3.versionsCampagnes.set(c.id!, (etatS3.versionsCampagnes.get(c.id!) ?? 1) + 1);
      return json(avecVersion(c), 200, { ETag: avecVersion(c).etag! });
    }),
    http.get(`${API}/campagnes/:id/apercu`, ({ params }) => {
      const c = etatS3.campagnes.find((x) => x.id === params.id);
      if (!c) return probleme(404, 'INTROUVABLE', 'Campagne introuvable');
      const periodes = genererPeriodes(c);
      const n = etatS3.membresCibles.length;
      const apercu: ApercuCampagne = {
        membresCibles: n,
        nombrePeriodes: periodes.length,
        nombreEcheances: n * periodes.length,
        montantTotal: n * periodes.length * c.montant,
        periodes: periodes.map((p) => ({
          numero: p.numero,
          libelle: p.libelle,
          dateEcheance: p.dateEcheance,
        })),
      };
      return json(apercu);
    }),
    http.post(`${API}/campagnes/:id/activer`, ({ params }) => {
      const c = etatS3.campagnes.find((x) => x.id === params.id);
      if (!c) return probleme(404, 'INTROUVABLE', 'Campagne introuvable');
      if (c.statut !== 'brouillon')
        return probleme(409, 'ETAT_INCOMPATIBLE', 'Seule une campagne en brouillon peut être activée');
      Object.assign(c, { statut: 'active', activeeAt: '2027-03-01T10:00:00Z' });
      etatS3.echeances.push(...echeancesDe(c, etatS3.membresCibles));
      return json(avecVersion(c));
    }),
    http.post(`${API}/campagnes/:id/cloturer`, ({ params }) => {
      const c = etatS3.campagnes.find((x) => x.id === params.id);
      if (!c) return probleme(404, 'INTROUVABLE', 'Campagne introuvable');
      Object.assign(c, { statut: 'cloturee' });
      return json(avecVersion(c));
    }),
    http.post(`${API}/campagnes/:id/membres`, async ({ request }) => {
      const corps = (await request.json()) as { membreIds: string[]; rattrapage?: boolean };
      return json({ echeancesCreees: corps.membreIds.length * (corps.rattrapage ? 4 : 2) });
    }),
    http.get(`${API}/campagnes/:id/statistiques`, ({ params }) => json(statistiques(String(params.id)))),
    http.get(`${API}/campagnes/:id/echeancier`, ({ params }) => {
      const e = etatS3.echeances.filter((x) => x.campagneId === params.id);
      const membres = [...new Map(e.map((x) => [x.membreId, x])).values()];
      return json({
        donnees: membres.map((m) => ({
          membreId: m.membreId,
          membreNumero: m.membreNumero,
          membreNom: m.membreNom,
          echeances: e.filter((x) => x.membreId === m.membreId),
        })),
        page: { curseurSuivant: null, total: null },
      });
    }),

    // --- Échéances (A10, ajustement, exonération)
    http.get(`${API}/echeances`, ({ request }) => {
      const url = new URL(request.url);
      const situation = url.searchParams.get('situation');
      const campagneId = url.searchParams.get('campagneId');
      const donnees = etatS3.echeances.filter(
        (e) => (!situation || e.situation === situation) && (!campagneId || e.campagneId === campagneId),
      );
      return json({ donnees, page: { curseurSuivant: null, total: null } });
    }),
    http.patch(`${API}/echeances/:id`, async ({ params, request }) => {
      const e = etatS3.echeances.find((x) => x.id === params.id);
      if (!e) return probleme(404, 'INTROUVABLE', 'Échéance introuvable');
      if (e.imputee) return probleme(422, 'ECHEANCE_DEJA_IMPUTEE', 'Un paiement est déjà imputé');
      Object.assign(e, await request.json());
      return json(e);
    }),
    http.post(`${API}/echeances/:id/exonerer`, async ({ params, request }) => {
      const e = etatS3.echeances.find((x) => x.id === params.id);
      if (!e) return probleme(404, 'INTROUVABLE', 'Échéance introuvable');
      const { motif } = (await request.json()) as { motif: string };
      Object.assign(e, { situation: 'exoneree', montantDu: 0, motifExoneration: motif });
      return json(e);
    }),
  ];
}

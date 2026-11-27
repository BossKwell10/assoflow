import {
  calculerSms,
  CODES_MODELES,
  estCodeModele,
  MODELES_NOTIFICATION,
  PAIEMENT_CONFIRMATION_AU_DELA,
  variablesInconnues,
} from '@assoflow/contracts';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type {
  Compte,
  Diffusion,
  ModeleNotification,
  Notification,
  Paiement,
  PaiementCreation,
  Reunion,
} from '../api/generated/modeles';

/**
 * Handlers du sprint 4 (paiements, comptes, communication, réunions), alignés sur docs/openapi.yaml.
 * État simulé réinitialisé entre les tests.
 */
export const etatS4: {
  comptes: Compte[];
  paiements: Paiement[];
  personnalises: Map<string, string>;
  notifications: Notification[];
  reunions: Reunion[];
  numero: number;
} = { comptes: [], paiements: [], personnalises: new Map(), notifications: [], reunions: [], numero: 0 };

export const CAISSE_ID = '0190a1b2-0000-7000-8000-0000000c0001';
export const WAVE_ID = '0190a1b2-0000-7000-8000-0000000c0002';
export const PAIEMENT_ID = '0190a1b2-0000-7000-8000-0000000a0001';

const recuSms = (id: string): Paiement['recuSms'] => ({
  notificationId: id,
  statut: 'en_attente',
  destinataireMasque: '+225 07 •• •• 03 04',
  relaisFamille: false,
});

function paiement(partiel: Partial<Paiement> & Pick<Paiement, 'id' | 'montant'>): Paiement {
  return {
    type: 'paiement',
    annulePaiementId: null,
    numeroRecu: `REC-2027-${String(++etatS4.numero).padStart(6, '0')}`,
    numeroRecuProvisoire: null,
    membreId: 'm-1',
    familleId: null,
    campagneId: null,
    mode: 'especes',
    operateurMm: null,
    referenceExterne: null,
    compteId: CAISSE_ID,
    datePaiement: '2027-03-05T09:14:00Z',
    recuServeurAt: '2027-03-05T09:14:02Z',
    saisiPar: { id: 'u-1', nom: 'Koffi Yao' },
    annule: false,
    imputations: [
      {
        echeanceId: 'e-1',
        membreId: 'm-1',
        libellePeriode: 'Mars 2027',
        campagneId: 'c-1',
        campagneLibelle: 'Cotisation mensuelle 2027',
        dateEcheance: '2027-03-05',
        montant: partiel.montant,
      },
    ],
    motif: null,
    membreNumero: 'MBR-000001',
    membreNom: 'Jean Kouassi',
    familleNom: null,
    compteLibelle: 'Caisse',
    exerciceId: 'ex-1',
    annulation: null,
    annulable: true,
    recuSms: recuSms(`n-${partiel.id}`),
    ...partiel,
  };
}

export function reinitialiserS4() {
  etatS4.numero = 0;
  etatS4.comptes = [
    { id: CAISSE_ID, type: 'caisse', libelle: 'Caisse', actif: true, solde: 120000 },
    { id: WAVE_ID, type: 'mobile_money', libelle: 'Wave trésorier', actif: true, solde: 30000 },
  ];
  etatS4.paiements = [
    paiement({ id: PAIEMENT_ID, montant: 2000 }),
    paiement({
      id: '0190a1b2-0000-7000-8000-0000000a0002',
      montant: 5000,
      mode: 'mobile_money',
      operateurMm: 'wave',
      compteId: WAVE_ID,
      compteLibelle: 'Wave trésorier',
      membreId: 'm-2',
      membreNumero: 'MBR-000002',
      membreNom: 'Awa Koné',
      annulable: false,
    }),
  ];
  etatS4.personnalises = new Map();
  etatS4.notifications = [
    {
      id: 'n-1',
      canal: 'sms',
      modeleCode: 'recu_paiement',
      destinataireMasque: '+225 07 •• •• 03 04',
      statut: 'remise',
      fournisseur: 'agregateur_a',
      unites: 1,
      createdAt: '2027-03-05T09:14:03Z',
      remiseAt: '2027-03-05T09:14:09Z',
      membreId: 'm-1',
      membreNom: 'Jean Kouassi',
      relaisFamille: false,
      priorite: 1,
      origineType: 'paiement',
      origineId: PAIEMENT_ID,
      contenu: 'MRK : recu REC-2027-000001 - 2 000 FCFA recus de Jean le 05/03/2027. Reste du : 0 FCFA.',
      tentatives: 1,
      derniereErreur: null,
      envoyeeAt: '2027-03-05T09:14:04Z',
    },
    {
      id: 'n-2',
      canal: 'sms',
      modeleCode: 'rappel_retard',
      destinataireMasque: '+225 01 •• •• 11 22',
      statut: 'hors_quota',
      fournisseur: null,
      unites: 1,
      createdAt: '2027-03-06T08:00:00Z',
      remiseAt: null,
      membreId: 'm-3',
      membreNom: 'Adjoua Kouassi',
      relaisFamille: true,
      priorite: 5,
      origineType: 'echeance',
      origineId: null,
      contenu: 'MRK : votre cotisation de 2 000 FCFA est en retard depuis le 05/02/2027.',
      tentatives: 0,
      derniereErreur: null,
      envoyeeAt: null,
    },
  ];
  etatS4.reunions = [
    {
      id: '0190a1b2-0000-7000-8000-00000000a6a1',
      type: 'ag_ordinaire',
      titre: 'Assemblee generale 2027',
      debut: '2099-04-12T10:00:00Z',
      lieu: 'Foyer des jeunes',
      ordreDuJour: null,
      statut: 'planifiee',
      pvDocumentId: null,
      presents: 0,
      convoques: 0,
    },
  ];
}

const API = '*/v1';
const json = (corps: JsonBodyType, status = 200) => HttpResponse.json(corps, { status });
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

function modele(code: string): ModeleNotification {
  const m = MODELES_NOTIFICATION[code as keyof typeof MODELES_NOTIFICATION];
  const perso = etatS4.personnalises.get(code);
  const contenu = perso ?? m.contenu;
  return {
    code,
    canal: 'sms',
    langue: 'fr',
    contenu,
    variables: [...m.variables],
    personnalise: perso !== undefined,
    libelle: m.libelle,
    contenuGlobal: m.contenu,
    unites: calculerSms(contenu).unites,
  };
}

export function handlersSprint4() {
  return [
    http.get(`${API}/comptes`, () => json(etatS4.comptes)),

    // --- Paiements (A11, A12)
    http.get(`${API}/paiements`, ({ request }) => {
      const p = new URL(request.url).searchParams;
      const donnees = etatS4.paiements.filter(
        (x) =>
          (!p.get('membreId') || x.membreId === p.get('membreId')) &&
          (!p.get('mode') || x.mode === p.get('mode')) &&
          (p.get('inclureAnnules') === 'true' || (x.type === 'paiement' && !x.annule)),
      );
      return json({ donnees, page: { curseurSuivant: null, total: null } });
    }),
    http.get(`${API}/paiements/:id`, ({ params }) => {
      const x = etatS4.paiements.find((p) => p.id === params.id);
      return x ? json(x) : probleme(404, 'INTROUVABLE', 'Paiement introuvable');
    }),
    http.get(`${API}/paiements/:id/recu`, () =>
      HttpResponse.arrayBuffer(new TextEncoder().encode('%PDF-1.7').buffer, {
        headers: { 'content-type': 'application/pdf' },
      }),
    ),
    http.post(`${API}/paiements`, async ({ request }) => {
      const c = (await request.json()) as PaiementCreation;
      if (c.montant > PAIEMENT_CONFIRMATION_AU_DELA && !c.confirmationMontantEleve) {
        return probleme(
          422,
          'CONFIRMATION_REQUISE',
          'Montant supérieur à 500 000 FCFA : confirmez le paiement',
        );
      }
      const compte = etatS4.comptes.find((x) => x.id === c.compteId);
      const x = paiement({
        id: c.id,
        montant: c.montant,
        membreId: c.membreId ?? null,
        familleId: c.familleId ?? null,
        mode: c.mode,
        operateurMm: c.operateurMm ?? null,
        compteId: c.compteId,
        compteLibelle: compte?.libelle ?? '',
        datePaiement: c.datePaiement,
        membreNom: c.membreId ? 'Jean Kouassi' : null,
        membreNumero: c.membreId ? 'MBR-000001' : null,
        familleNom: c.familleId ? 'Famille Kouassi' : null,
      });
      etatS4.paiements.unshift(x);
      return json(x, 201);
    }),
    http.post(`${API}/paiements/:id/annuler`, async ({ params, request }) => {
      const x = etatS4.paiements.find((p) => p.id === params.id);
      if (!x) return probleme(404, 'INTROUVABLE', 'Paiement introuvable');
      if (x.annule) return probleme(409, 'ETAT_INCOMPATIBLE', 'Paiement déjà annulé');
      const { motif } = (await request.json()) as { motif: string };
      const a = paiement({
        id: crypto.randomUUID(),
        type: 'annulation',
        annulePaiementId: x.id,
        montant: x.montant,
        motif,
        annulable: false,
        imputations: x.imputations.map((i) => ({ ...i, montant: -i.montant })),
      });
      Object.assign(x, {
        annule: true,
        annulable: false,
        annulation: {
          id: a.id,
          numeroRecu: a.numeroRecu,
          motif,
          datePaiement: '2027-03-06T10:00:00Z',
          saisiPar: 'Koffi Yao',
        },
      });
      etatS4.paiements.unshift(a);
      return json(a, 201);
    }),
    http.post(`${API}/paiements/:id/renvoyer-recu`, ({ params }) => {
      const n = {
        ...etatS4.notifications[0]!,
        id: `n-renvoi-${String(params.id)}`,
        statut: 'en_attente' as const,
      };
      etatS4.notifications.unshift(n);
      return json(n, 202);
    }),

    // --- Relances (A10)
    http.post(`${API}/echeances/relancer`, async ({ request }) => {
      const { echeanceIds } = (await request.json()) as { echeanceIds: string[] };
      const d: Diffusion = {
        notifications: Math.min(echeanceIds.length, 1),
        dejaEnvoyees: 0,
        sansContact: echeanceIds.length > 1 ? 1 : 0,
        unitesEstimees: 1,
        quotaRestant: 412,
      };
      return json(d);
    }),

    // --- Communication (A21, A22)
    http.get(`${API}/modeles-notification`, () =>
      json(CODES_MODELES.filter((c) => MODELES_NOTIFICATION[c].personnalisable).map(modele)),
    ),
    http.put(`${API}/modeles-notification/:code/:canal`, async ({ params, request }) => {
      const code = String(params.code);
      if (!estCodeModele(code)) return probleme(404, 'INTROUVABLE', 'Modèle introuvable');
      const { contenu } = (await request.json()) as { contenu: string };
      const inconnues = variablesInconnues(code, contenu);
      if (inconnues.length > 0) {
        const message = `Variable inconnue pour ce modèle : ${inconnues.join(', ')}`;
        return probleme(422, 'VALIDATION', message, [
          { champ: 'contenu', code: 'VARIABLE_INCONNUE', message },
        ]);
      }
      etatS4.personnalises.set(code, contenu);
      return json(modele(code));
    }),
    http.delete(`${API}/modeles-notification/:code/:canal`, ({ params }) => {
      etatS4.personnalises.delete(String(params.code));
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/notifications`, ({ request }) => {
      const p = new URL(request.url).searchParams;
      const donnees = etatS4.notifications.filter(
        (n) =>
          (!p.get('statut') || n.statut === p.get('statut')) &&
          (!p.get('modele') || n.modeleCode === p.get('modele')),
      );
      return json({ donnees, page: { curseurSuivant: null, total: null } });
    }),
    http.get(`${API}/sms/consommation`, () =>
      json({
        mois: '2027-03-01',
        quota: 500,
        unites: 412,
        pourcentage: 82,
        horsQuota: 1,
        parModele: { recu_paiement: 300, rappel_retard: 112 },
      }),
    ),

    // --- Réunions (E6-08)
    http.get(`${API}/reunions`, () => json({ donnees: etatS4.reunions, page: { curseurSuivant: null } })),
    http.post(`${API}/reunions`, async ({ request }) => {
      const r = {
        ...((await request.json()) as Reunion),
        id: crypto.randomUUID(),
        statut: 'planifiee' as const,
      };
      etatS4.reunions.unshift(r);
      return json(r, 201);
    }),
    http.post(`${API}/reunions/:id/convoquer`, ({ params }) => {
      const r = etatS4.reunions.find((x) => x.id === params.id);
      if (!r) return probleme(404, 'INTROUVABLE', 'Réunion introuvable');
      Object.assign(r, { convoques: 3 });
      const d: Diffusion = {
        notifications: 3,
        dejaEnvoyees: 0,
        sansContact: 1,
        unitesEstimees: 3,
        quotaRestant: 88,
      };
      return json(d);
    }),
  ];
}

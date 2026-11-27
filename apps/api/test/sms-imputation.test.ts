import { describe, expect, it } from 'vitest';
import { AgregateurHttpSms } from '../src/infra/sms/agregateur-http.js';
import { ErreurFournisseurSms } from '../src/infra/sms/fournisseur-sms.js';
import { RouteurSms } from '../src/infra/sms/routeur-sms.js';
import { SimulateurSms } from '../src/infra/sms/simulateur-sms.js';
import { ventiler, type EcheanceDue } from '../src/modules/paiements/imputation.js';

const e = (id: string, date: string, reste: number, extra: Partial<EcheanceDue> = {}): EcheanceDue => ({
  id,
  membreId: 'm1',
  numeroMembre: 'MBR-000001',
  campagneId: 'c1',
  dateEcheance: date,
  numeroPeriode: 1,
  reste,
  ...extra,
});

describe('RG-COT-020 / 021 : ventilation d’un paiement', () => {
  const dues = [
    e('futur', '2027-06-10', 2000),
    e('vieux', '2027-01-10', 2000),
    e('recent', '2027-03-10', 2000),
    e('cible', '2027-05-01', 5000, { campagneId: 'c2' }),
  ];

  it('échues par date croissante, puis à venir, puis avance', () => {
    expect(ventiler(7000, dues, { aujourdhui: '2027-04-01' })).toEqual({
      lignes: [
        { echeanceId: 'vieux', membreId: 'm1', montant: 2000 },
        { echeanceId: 'recent', membreId: 'm1', montant: 2000 },
        { echeanceId: 'cible', membreId: 'm1', montant: 3000 },
      ],
      avance: 0,
    });
    expect(ventiler(20000, dues, { aujourdhui: '2027-04-01' }).avance).toBe(9000);
  });

  it('campagne ciblée d’abord, même si ses échéances sont à venir', () => {
    const r = ventiler(6000, dues, { aujourdhui: '2027-04-01', campagneId: 'c2' });
    expect(r.lignes.map((l) => [l.echeanceId, l.montant])).toEqual([
      ['cible', 5000],
      ['vieux', 1000],
    ]);
  });

  it('famille : à date égale, par numéro de membre', () => {
    const famille = [
      e('b', '2027-01-10', 1000, { membreId: 'm2', numeroMembre: 'MBR-000002' }),
      e('a', '2027-01-10', 1000, { membreId: 'm1', numeroMembre: 'MBR-000001' }),
    ];
    expect(ventiler(1500, famille, { aujourdhui: '2027-04-01' }).lignes).toEqual([
      { echeanceId: 'a', membreId: 'm1', montant: 1000 },
      { echeanceId: 'b', membreId: 'm2', montant: 500 },
    ]);
  });
});

describe('docs/06 §4.1 : routeur SMS', () => {
  const msg = { to: '+2250101020304', texte: 'Bonjour', ref: 'n1' };

  it('bascule sur le fournisseur suivant après une erreur, et signale l’échec transitoire de tous', async () => {
    const a = new SimulateurSms('simulateur', true, undefined, 'transitoire');
    const b = new SimulateurSms('simulateur_b', true, undefined);
    const routeur = new RouteurSms([a, b]);
    expect((await routeur.router(msg)).fournisseur).toBe('simulateur_b');
    b.panne = 'definitive';
    const erreur = await routeur.router(msg).catch((x: unknown) => x);
    expect(erreur).toBeInstanceOf(ErreurFournisseurSms);
    expect((erreur as ErreurFournisseurSms).transitoire).toBe(true);
    a.panne = 'definitive';
    expect(((await routeur.router(msg).catch((x: unknown) => x)) as ErreurFournisseurSms).transitoire).toBe(
      false,
    );
  });

  it('disjoncteur : un fournisseur sous 90 % de remise sur au moins 20 messages passe en dernier', async () => {
    const a = new SimulateurSms('simulateur', true, undefined);
    const b = new SimulateurSms('simulateur_b', true, undefined);
    const stats = async (code: string) =>
      code === 'simulateur' ? { envoyes: 50, remis: 30 } : { envoyes: 50, remis: 49 };
    expect((await new RouteurSms([a, b], stats).router(msg)).fournisseur).toBe('simulateur_b');
    const peu = async () => ({ envoyes: 5, remis: 0 });
    expect((await new RouteurSms([a, b], peu).router(msg)).fournisseur).toBe('simulateur');
  });
});

describe('adaptateur HTTP d’agrégateur', () => {
  const config = {
    code: 'agregateur_a',
    url: 'https://sms.exemple.ci/v1/messages',
    jeton: 'jeton',
    expediteur: 'AssoFlow',
    secretWebhook: 'secret-webhook-0123456789',
    prefixes: ['+225'],
  };
  const reponse = (status: number, corps: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(corps), { status, headers: { 'content-type': 'application/json' } }),
    );

  it('envoie en JSON avec jeton Bearer et lit l’identifiant et les segments', async () => {
    let requete: { url: string; init: RequestInit } | undefined;
    const fetchFn = ((url: string, init: RequestInit) => {
      requete = { url, init };
      return reponse(200, { messageId: 'abc', segments: 2 });
    }) as unknown as typeof fetch;
    const r = await new AgregateurHttpSms(config, fetchFn).envoyer({
      to: '+2250101020304',
      texte: 'x',
      ref: 'n1',
    });
    expect(r).toEqual({ idFournisseur: 'abc', unites: 2 });
    expect((requete!.init.headers as Record<string, string>).authorization).toBe('Bearer jeton');
    expect(JSON.parse(String(requete!.init.body))).toMatchObject({ from: 'AssoFlow', reference: 'n1' });
  });

  it('5xx et 429 transitoires, 4xx définitives ; routage par préfixe ; accusés authentifiés', async () => {
    const avec = (status: number) =>
      new AgregateurHttpSms(config, (() => reponse(status, {})) as unknown as typeof fetch);
    const erreur = (status: number) =>
      avec(status)
        .envoyer({ to: '+2250101020304', texte: 'x', ref: 'n' })
        .catch((x: ErreurFournisseurSms) => x.transitoire);
    expect(await erreur(503)).toBe(true);
    expect(await erreur(429)).toBe(true);
    expect(await erreur(400)).toBe(false);
    const f = avec(200);
    expect(f.prendEnCharge('+2250101020304')).toBe(true);
    expect(f.prendEnCharge('+33601020304')).toBe(false);
    expect(
      f.traiterAccuse({ messageId: 'abc', status: 'DELIVERED' }, { 'x-webhook-token': 'non' }),
    ).toBeNull();
    expect(
      f.traiterAccuse({ messageId: 'abc', status: 'DELIVERED' }, { 'x-webhook-token': config.secretWebhook }),
    ).toMatchObject({ idFournisseur: 'abc', statut: 'remise' });
    expect(
      f.traiterAccuse(
        { messageId: 'abc', status: 'UNDELIVERED' },
        { 'x-webhook-token': config.secretWebhook },
      ),
    ).toMatchObject({ statut: 'echec' });
  });
});

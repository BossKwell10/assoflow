import { describe, expect, it } from 'vitest';
import {
  calculerSms,
  convocationSchema,
  MODELES_NOTIFICATION,
  montantSms,
  rendreModele,
  variablesInconnues,
} from './notifications.js';
import { paiementCreationSchema } from './paiements.js';

const UUID_A = '0190f0b2-0000-7000-8000-000000000002';
const UUID_B = '0190f0b2-0000-7000-8000-000000000003';

describe('docs/06 §4.3 : unités SMS', () => {
  it('GSM-7 : 160 septets pour une unité, 153 par unité au-delà ; accents courants acceptés', () => {
    expect(calculerSms('a'.repeat(160))).toMatchObject({ encodage: 'gsm7', unites: 1 });
    expect(calculerSms('a'.repeat(161)).unites).toBe(2);
    expect(calculerSms('a'.repeat(306)).unites).toBe(2);
    expect(calculerSms('a'.repeat(307)).unites).toBe(3);
    expect(calculerSms('é è à ù').encodage).toBe('gsm7');
  });

  it('table d’extension : 2 septets par caractère', () => {
    expect(calculerSms('€'.repeat(80))).toMatchObject({ encodage: 'gsm7', longueur: 160, unites: 1 });
    expect(calculerSms('€'.repeat(81)).unites).toBe(2);
  });

  it('un seul caractère hors GSM-7 (ê, ô, ç, ’) passe le message en Unicode : 70 puis 67 par unité', () => {
    const r = calculerSms(`Fête ${'a'.repeat(60)}`);
    expect(r).toMatchObject({ encodage: 'unicode', unites: 1, horsGsm7: ['ê'] });
    expect(calculerSms(`ç${'a'.repeat(70)}`).unites).toBe(2);
    expect(calculerSms('l’app').encodage).toBe('unicode');
  });

  it('les modèles globaux par défaut tiennent en GSM-7', () => {
    for (const [code, m] of Object.entries(MODELES_NOTIFICATION)) {
      expect(calculerSms(m.contenu).encodage, code).toBe('gsm7');
    }
  });
});

describe('RF-SUP-042 : rendu des modèles', () => {
  it('remplace les variables par leurs valeurs échappées (sans accolades ni contrôle)', () => {
    const texte = rendreModele(MODELES_NOTIFICATION.annulation_paiement.contenu, {
      'association.sigle': 'MRK',
      'paiement.numero_recu': 'REC-2027-000001',
      'paiement.montant': montantSms(25000),
      motif: 'Saisie {{code}}\nerronée',
    });
    expect(texte).toBe(
      'MRK : le recu REC-2027-000001 de 25 000 FCFA a ete annule. Motif : Saisie code erronée.',
    );
  });

  it('une variable absente est rendue vide ; les variables étrangères au modèle sont signalées', () => {
    expect(rendreModele('{{a}}-{{ b }}', { a: 1 })).toBe('1-');
    expect(
      variablesInconnues('rappel_avant', 'Payez {{montant}} avant le {{date}} {{membre.telephone}}'),
    ).toEqual(['membre.telephone']);
  });
});

describe('RG-COT-030 : saisie d’un paiement', () => {
  const base = {
    id: '0190f0b2-0000-7000-8000-000000000001',
    montant: 5000,
    mode: 'especes',
    compteId: UUID_A,
    datePaiement: '2027-03-05T09:14:00Z',
  };

  it('exactement un membre ou une famille', () => {
    expect(paiementCreationSchema.safeParse(base).success).toBe(false);
    expect(paiementCreationSchema.safeParse({ ...base, membreId: UUID_B }).success).toBe(true);
    expect(paiementCreationSchema.safeParse({ ...base, membreId: UUID_B, familleId: UUID_B }).success).toBe(
      false,
    );
  });

  it('mobile money : opérateur obligatoire ; montant entier ≤ 5 000 000', () => {
    const m = { ...base, membreId: UUID_B, mode: 'mobile_money' };
    expect(paiementCreationSchema.safeParse(m).success).toBe(false);
    expect(paiementCreationSchema.safeParse({ ...m, operateurMm: 'wave' }).success).toBe(true);
    expect(paiementCreationSchema.safeParse({ ...base, membreId: UUID_B, montant: 5_000_001 }).success).toBe(
      false,
    );
    expect(paiementCreationSchema.safeParse({ ...base, membreId: UUID_B, montant: 10.5 }).success).toBe(
      false,
    );
  });
});

describe('E6-08 : cible d’une convocation', () => {
  it('une seule cible, canal SMS seulement', () => {
    expect(convocationSchema.safeParse({ cible: { tous: true } }).success).toBe(true);
    expect(convocationSchema.safeParse({ cible: {} }).success).toBe(false);
    expect(convocationSchema.safeParse({ cible: { tous: true, membres: [UUID_B] } }).success).toBe(false);
    expect(convocationSchema.safeParse({ cible: { tous: true }, canaux: ['push'] }).success).toBe(false);
  });
});

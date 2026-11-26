import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSIONS_RESERVEES_PRESIDENT,
  ROLES_SYSTEME,
  formatMontant,
  masquerTelephone,
  normaliserTelephone,
  parseMontant,
} from './index.js';

describe('montants (D-007)', () => {
  it('lit une saisie avec séparateurs', () => {
    expect(parseMontant('25 000')).toBe(25000);
    expect(parseMontant('150\u202f000')).toBe(150000);
  });
  it('refuse les décimales et les négatifs', () => {
    expect(() => parseMontant('2500,50')).toThrow();
    expect(() => parseMontant('-5')).toThrow();
  });
  it('formate avec espaces des milliers', () => {
    expect(formatMontant(2384500)).toBe('2\u202f384\u202f500\u00a0FCFA');
    expect(formatMontant(-4000, false)).toBe('−4\u202f000');
  });
});

describe('téléphones (RG-MBR-007)', () => {
  it('ajoute +225 aux numéros ivoiriens', () => {
    expect(normaliserTelephone('07 01 02 03 04')).toBe('+2250701020304');
  });
  it('garde un numéro international', () => {
    expect(normaliserTelephone('0033 6 12 34 56 78')).toBe('+33612345678');
  });
  it('masque un numéro', () => {
    expect(masquerTelephone('+2250701024118')).toBe('+225 07 •• •• 41 18');
  });
});

describe('rôles système', () => {
  it("n'utilisent que des permissions du catalogue", () => {
    for (const role of Object.values(ROLES_SYSTEME)) {
      for (const p of role.permissions) expect(PERMISSIONS).toContain(p);
    }
  });
  it('le président a les permissions réservées, pas les autres rôles', () => {
    for (const p of PERMISSIONS_RESERVEES_PRESIDENT) {
      expect(ROLES_SYSTEME.president.permissions).toContain(p);
      expect(ROLES_SYSTEME.tresorier.permissions).not.toContain(p);
    }
  });
  it('le président ne paie pas les dépenses (séparation des tâches)', () => {
    expect(ROLES_SYSTEME.president.permissions).not.toContain('depense.payer');
  });
});

import { describe, expect, it } from 'vitest';
import { verifierMotDePasse } from './mot-de-passe.js';

describe('politique de mot de passe (RF-SUP-053)', () => {
  const tel = '+2250701024118';

  it('accepte un mot de passe long et peu courant', () => {
    expect(verifierMotDePasse('Kossou-Lagune-2027!', tel)).toEqual([]);
  });

  it('exige 10 caractères minimum', () => {
    expect(verifierMotDePasse('Abc-12345', tel)).toContain('TROP_COURT');
    expect(verifierMotDePasse('Abcd-12345', tel)).not.toContain('TROP_COURT');
  });

  it('compte les caractères, pas les octets', () => {
    expect(verifierMotDePasse('ééééééééé1', tel)).not.toContain('TROP_COURT');
  });

  it('refuse les mots de passe courants, sans tenir compte de la casse', () => {
    expect(verifierMotDePasse('azerty1234', tel)).toContain('TROP_COURANT');
    expect(verifierMotDePasse('MotDePasse123', tel)).toContain('TROP_COURANT');
    expect(verifierMotDePasse('1234567890', tel)).toContain('TROP_COURANT');
  });

  it('refuse une suite de chiffres du téléphone', () => {
    expect(verifierMotDePasse('Kossou0701024118', tel)).toContain('SUITE_TELEPHONE');
    expect(verifierMotDePasse('Kossou-024118-x', tel)).toContain('SUITE_TELEPHONE');
    expect(verifierMotDePasse('Kossou-2250701', tel)).toContain('SUITE_TELEPHONE');
  });

  it('tolère quelques chiffres communs avec le téléphone', () => {
    expect(verifierMotDePasse('Kossou-0701-lagune', tel)).toEqual([]);
  });

  it('cumule les problèmes', () => {
    expect(verifierMotDePasse('024118', tel)).toEqual(['TROP_COURT', 'SUITE_TELEPHONE']);
  });
});

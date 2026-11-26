import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ErreurMetier } from '../src/common/erreur-metier.js';
import { ProblemeFilter } from '../src/common/probleme.filter.js';

describe('ProblemeFilter', () => {
  const filtre = new ProblemeFilter();

  it('traduit une erreur métier', () => {
    const p = filtre.versProbleme(
      new ErreurMetier('SOLDE_INSUFFISANT', 'Solde de la caisse insuffisant'),
      'r1',
    );
    expect(p).toMatchObject({ status: 422, code: 'SOLDE_INSUFFISANT', requestId: 'r1' });
  });

  it('traduit une exception HTTP Nest', () => {
    expect(filtre.versProbleme(new NotFoundException(), 'r2')).toMatchObject({
      status: 404,
      code: 'INTROUVABLE',
    });
  });

  it("ne divulgue jamais le détail d'une erreur inattendue", () => {
    const p = filtre.versProbleme(new Error('mot de passe de la base : secret'), 'r3');
    expect(p).toMatchObject({ status: 500, code: 'ERREUR_INTERNE', detail: 'Erreur interne' });
  });
});

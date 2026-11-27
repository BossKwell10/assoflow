import { describe, expect, it } from 'vitest';
import { analyserLigne, lireDate, type Referentiels } from '../src/modules/membres/import/analyse.js';
import {
  lireCsv,
  lireFichierImport,
  normaliserEntete,
} from '../src/modules/membres/import/lecture-fichier.js';

const ref: Referentiels = {
  categories: new Map([['actifs', 'cat-1']]),
  familles: new Map([
    ['famille kone', { id: 'fam-1', nom: 'Famille Koné', chefJoignable: true }],
    ['famille muette', { id: 'fam-2', nom: 'Famille Muette', chefJoignable: false }],
  ]),
  aujourdhui: '2027-03-01',
};

describe('lecture du fichier d’import (RG-MBR-007)', () => {
  it('CSV : séparateur détecté, guillemets, retours à la ligne dans un champ, CRLF', () => {
    expect(lireCsv('a;b\r\n"x;y";"il dit ""oui"""\r\n')).toEqual([
      ['a', 'b'],
      ['x;y', 'il dit "oui"'],
    ]);
    expect(lireCsv('a,b\n1,"2\n3"')).toEqual([
      ['a', 'b'],
      ['1', '2\n3'],
    ]);
    expect(lireCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('en-têtes : accents, casse, apostrophes et alias', () => {
    expect(normaliserEntete(' Date d’adhésion ')).toBe('date_d_adhesion');
    expect(normaliserEntete('PRÉNOMS')).toBe('prenoms');
  });

  it('Windows-1252 (export Excel français) relu sans perte ; numéros de ligne conservés', async () => {
    const texte = 'nom;prenoms\n\nKoné;Éloïse\n';
    const cp1252 = Buffer.from(texte, 'latin1');
    const { lignes } = await lireFichierImport(cp1252);
    expect(lignes).toEqual([{ numero: 3, nom: 'Koné', prenoms: 'Éloïse' }]);
  });

  it('colonnes inconnues signalées, colonne en double refusée', async () => {
    const { colonnesIgnorees } = await lireFichierImport(Buffer.from('nom;prenoms;profession\nA;B;C'));
    expect(colonnesIgnorees).toEqual(['profession']);
    await expect(lireFichierImport(Buffer.from('nom;prenoms;tel;telephone\nA;B;1;2'))).rejects.toMatchObject({
      erreurs: [{ code: 'COLONNE_EN_DOUBLE' }],
    });
  });
});

describe('analyse d’une ligne', () => {
  it('dates : formats français, ISO, série Excel ; dates impossibles refusées', () => {
    expect(lireDate('5/3/2027')).toBe('2027-03-05');
    expect(lireDate('05.03.2027')).toBe('2027-03-05');
    expect(lireDate('2027-03-05')).toBe('2027-03-05');
    expect(lireDate('28857')).toBe('1979-01-02');
    expect(lireDate('29/02/2027')).toBeNull();
    expect(lireDate('03/2027')).toBeNull();
  });

  it('normalise téléphone, sexe, pays, catégorie et famille existante', () => {
    const r = analyserLigne(
      {
        numero: 2,
        nom: ' Koné ',
        prenoms: 'Awa',
        telephone: '07 08 09 10 11',
        sexe: 'Féminin',
        pays_residence: "Côte d'Ivoire",
        categorie: 'ACTIFS',
        famille: 'famille  koné',
      },
      ref,
    );
    expect(r).toEqual({
      donnees: expect.objectContaining({
        nom: 'Koné',
        telephone: '+2250708091011',
        sexe: 'F',
        paysResidence: 'CI',
        categorieId: 'cat-1',
        famille: { id: 'fam-1', nom: 'Famille Koné' },
      }),
    });
  });

  it('RG-MBR-002 : sans téléphone, accepté seulement si le chef de la famille existante est joignable', () => {
    expect(analyserLigne({ numero: 2, nom: 'A', prenoms: 'B', famille: 'Famille Koné' }, ref)).toHaveProperty(
      'donnees',
    );
    for (const famille of ['Famille Muette', 'Nouvelle famille', undefined]) {
      expect(analyserLigne({ numero: 2, nom: 'A', prenoms: 'B', famille }, ref)).toEqual({
        erreurs: [expect.stringContaining('RG-MBR-002')],
      });
    }
  });

  it('date future refusée', () => {
    expect(
      analyserLigne(
        { numero: 2, nom: 'A', prenoms: 'B', telephone: '0701020304', date_adhesion: '02/03/2027' },
        ref,
      ),
    ).toEqual({ erreurs: ['date d’adhésion dans le futur'] });
  });
});

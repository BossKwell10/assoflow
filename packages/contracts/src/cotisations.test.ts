import { describe, expect, it } from 'vitest';
import { campagneCreationSchema, genererPeriodes } from './cotisations.js';

const libelles = (p: ReturnType<typeof genererPeriodes>) => p.map((x) => `${x.libelle}@${x.dateEcheance}`);

describe('RG-COT-011 : périodes d’une campagne', () => {
  it('mensuelle : un mois civil par période, jour d’échéance borné par les dates de la campagne', () => {
    const p = genererPeriodes({
      periodicite: 'mensuelle',
      dateDebut: '2027-01-15',
      dateFin: '2027-04-03',
      jourEcheance: 10,
    });
    expect(libelles(p)).toEqual([
      'Janvier 2027@2027-01-15',
      'Février 2027@2027-02-10',
      'Mars 2027@2027-03-10',
      'Avril 2027@2027-04-03',
    ]);
    expect(p.map((x) => x.numero)).toEqual([1, 2, 3, 4]);
    expect(p[0]).toMatchObject({ debut: '2027-01-15', fin: '2027-01-31' });
  });

  it('trimestrielle, semestrielle, annuelle : périodes civiles ; passage d’année', () => {
    expect(
      libelles(
        genererPeriodes({ periodicite: 'trimestrielle', dateDebut: '2027-02-01', dateFin: '2028-01-31' }),
      ),
    ).toEqual([
      'T1 2027@2027-02-01',
      'T2 2027@2027-04-05',
      'T3 2027@2027-07-05',
      'T4 2027@2027-10-05',
      'T1 2028@2028-01-05',
    ]);
    expect(
      libelles(
        genererPeriodes({ periodicite: 'semestrielle', dateDebut: '2027-01-01', dateFin: '2027-12-31' }),
      ),
    ).toEqual(['S1 2027@2027-01-05', 'S2 2027@2027-07-05']);
    expect(
      libelles(
        genererPeriodes({
          periodicite: 'annuelle',
          dateDebut: '2027-03-01',
          dateFin: '2028-12-31',
          jourEcheance: 1,
        }),
      ),
    ).toEqual(['2027@2027-03-01', '2028@2028-01-01']);
  });

  it('unique : une échéance à la date de début', () => {
    expect(
      libelles(genererPeriodes({ periodicite: 'unique', dateDebut: '2027-05-20', dateFin: '2027-06-30' })),
    ).toEqual(['Échéance unique@2027-05-20']);
  });

  it('prolonger la fin garde les numéros des périodes existantes', () => {
    const court = genererPeriodes({
      periodicite: 'mensuelle',
      dateDebut: '2027-01-01',
      dateFin: '2027-03-31',
    });
    const long = genererPeriodes({
      periodicite: 'mensuelle',
      dateDebut: '2027-01-01',
      dateFin: '2027-06-30',
    });
    expect(long.slice(0, 3)).toEqual(court);
    expect(long).toHaveLength(6);
  });
});

describe('campagne', () => {
  const base = {
    exerciceId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    libelle: 'Cotisation 2027',
    type: 'ordinaire',
    montant: 2000,
    periodicite: 'mensuelle',
    dateDebut: '2027-01-01',
    dateFin: '2027-12-31',
  };
  it('RF-037 : une cotisation exceptionnelle exige un motif ; fin après début ; montant entier positif', () => {
    expect(campagneCreationSchema.safeParse(base).success).toBe(true);
    const r = campagneCreationSchema.safeParse({
      ...base,
      type: 'exceptionnelle',
      dateFin: '2026-12-31',
      montant: 0,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0]).sort()).toEqual(['dateFin', 'montant', 'motif']);
    expect(campagneCreationSchema.safeParse({ ...base, montant: 10.5 }).success).toBe(false);
  });
});

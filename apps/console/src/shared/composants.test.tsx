import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChampMontant } from './ChampMontant';
import { ChampTelephone, lireTelephone } from './ChampTelephone';
import { versCsv } from './csv';
import { DepotFichier } from './DepotFichier';
import { BadgeStatut } from './Statut';
import { uuidV7 } from './uuid';

const rendre = (ui: React.ReactNode) => {
  // `applyAccept: false` : le navigateur laisse choisir « Tous les fichiers », le contrôle doit être fait par le code.
  const utilisateur = userEvent.setup({ applyAccept: false });
  return { ...render(<MantineProvider env="test">{ui}</MantineProvider>), utilisateur };
};

describe('composants partagés (docs/08 §7)', () => {
  it('ChampMontant : entier FCFA, séparateur de milliers, refus des décimales', async () => {
    const valeurs: (number | null)[] = [];
    function Montant() {
      const [v, setV] = useState<number | null>(null);
      return (
        <ChampMontant
          label="Seuil"
          value={v}
          onChange={(n) => {
            valeurs.push(n);
            setV(n);
          }}
        />
      );
    }
    const { utilisateur: u } = rendre(<Montant />);
    const champ = screen.getByLabelText('Seuil');
    await u.type(champ, '150000');
    expect(valeurs.at(-1)).toBe(150000);
    await u.tab();
    expect(champ).toHaveValue('150 000');

    await u.clear(champ);
    await u.type(champ, '2500,5');
    expect(screen.getByText('Montant entier en FCFA, sans décimale.')).toBeInTheDocument();
    expect(valeurs.at(-1)).toBe(2500);
  });

  it('ChampTelephone : +225 par défaut et normalisation E.164', async () => {
    expect(lireTelephone('07 01 02 03 04')).toBe('+2250701020304');
    expect(lireTelephone('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(lireTelephone('')).toBeNull();
    expect(lireTelephone('12')).toBeUndefined();
    function Telephone() {
      const [v, setV] = useState('');
      return <ChampTelephone label="Téléphone" value={v} onChange={setV} />;
    }
    const { utilisateur: u } = rendre(<Telephone />);
    await u.type(screen.getByLabelText('Téléphone'), '0701020304');
    await u.tab();
    expect(screen.getByLabelText('Téléphone')).toHaveValue('+225 07 01 02 03 04');
  });

  it('DepotFichier : contrôle le type et la taille avant envoi', async () => {
    const onFichier = vi.fn();
    const { utilisateur: u } = rendre(
      <DepotFichier
        label="Photo"
        types={['image/jpeg', 'image/png']}
        tailleMax={1024}
        onFichier={onFichier}
      />,
    );
    const champ = screen.getByLabelText('Photo');
    await u.upload(champ, new File(['x'], 'note.pdf', { type: 'application/pdf' }));
    expect(screen.getByText('Type de fichier refusé. Formats acceptés : JPEG, PNG.')).toBeInTheDocument();
    await u.upload(champ, new File([new Uint8Array(2048)], 'grande.png', { type: 'image/png' }));
    expect(screen.getByText(/Fichier trop volumineux/)).toBeInTheDocument();
    expect(onFichier).not.toHaveBeenCalled();
    await u.upload(champ, new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(onFichier).toHaveBeenCalledTimes(1);
    expect(screen.getByText('photo.png')).toBeInTheDocument();
  });

  it('BadgeStatut : libellé et couleur depuis le dictionnaire partagé', () => {
    rendre(<BadgeStatut domaine="membreEtat" valeur="suspendu" />);
    expect(screen.getByText('Suspendu')).toBeInTheDocument();
  });

  it('versCsv : séparateur ;, guillemets, BOM et neutralisation des formules', () => {
    const csv = versCsv(
      [
        { titre: 'Nom', valeur: (l: { nom: string; n: number }) => l.nom },
        { titre: 'Solde', valeur: (l) => l.n },
      ],
      [
        { nom: 'Koné; Awa', n: -1500 },
        { nom: '=SOMME(A1)', n: 0 },
      ],
    );
    expect(csv).toBe('﻿Nom;Solde\r\n"Koné; Awa";-1500\r\n\'=SOMME(A1);0\r\n');
  });

  it('uuidV7 : version 7, variante RFC, ordonné dans le temps', () => {
    const a = uuidV7(1_700_000_000_000);
    const b = uuidV7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
    expect(a.slice(0, 13)).toBe('018bcfe5-6800');
  });
});

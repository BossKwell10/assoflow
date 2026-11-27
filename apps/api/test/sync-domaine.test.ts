import { comparerVersions, syncPushSchema } from '@assoflow/contracts';
import { describe, expect, it } from 'vitest';
import { prefixeDuRang } from '../src/modules/sync/appareils.service.js';
import { detecterTypePiece } from '../src/modules/sync/pieces-jointes.service.js';

describe('RG-NUM-003 : préfixe d’appareil', () => {
  it('lettre + 2 chiffres dans l’ordre d’enregistrement, jamais réutilisé', () => {
    expect([1, 2, 99, 100, 101, 2599].map(prefixeDuRang)).toEqual(['A01', 'A02', 'A99', 'B00', 'B01', 'Z99']);
    expect(() => prefixeDuRang(2600)).toThrow();
    expect(() => prefixeDuRang(0)).toThrow();
  });
});

describe('docs/05 §7 : type réel d’une pièce jointe', () => {
  it('reconnaît PDF, images, audio par leurs octets de signature', () => {
    expect(detecterTypePiece(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(detecterTypePiece(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(detecterTypePiece(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')]))).toBe('audio/mp4');
    expect(detecterTypePiece(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBe('audio/aac');
    expect(detecterTypePiece(Buffer.from('<html>'))).toBeNull();
  });
});

describe('docs/05 §8 : versions et taille de lot', () => {
  it('compare les versions X.Y.Z numériquement', () => {
    expect(comparerVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(comparerVersions('0.9.0', '1.0.0')).toBeLessThan(0);
    expect(comparerVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('refuse plus de 500 éléments par push et les tables inconnues', () => {
    const lignes = Array.from({ length: 501 }, (_, i) => ({ id: String(i) }));
    expect(
      syncPushSchema.safeParse({
        curseurBase: 0,
        versionSchema: 1,
        changes: { membres: { created: lignes } },
      }).success,
    ).toBe(false);
    expect(
      syncPushSchema.safeParse({ curseurBase: 0, versionSchema: 1, changes: { users: { created: [] } } })
        .success,
    ).toBe(false);
  });
});

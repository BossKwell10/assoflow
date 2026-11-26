import { describe, expect, it } from 'vitest';
import { avecEtag, etagDe, verifierIfMatch } from '../src/common/concurrence.js';
import { detecterTypeImage } from '../src/common/images.js';
import { ErreurMetier } from '../src/common/erreur-metier.js';
import { IMAGES } from './outils-integration.js';

function code(f: () => void): string | undefined {
  try {
    f();
    return undefined;
  } catch (e) {
    return (e as ErreurMetier).code;
  }
}

describe('concurrence optimiste (docs/07 §5)', () => {
  const etag = etagDe(42);

  it('If-Match absent : 428 depuis la console, toléré depuis le mobile', () => {
    expect(code(() => verifierIfMatch(undefined, etag, 'console'))).toBe('PRECONDITION_REQUISE');
    expect(code(() => verifierIfMatch('', etag, 'console'))).toBe('PRECONDITION_REQUISE');
    expect(code(() => verifierIfMatch(undefined, etag, 'mobile'))).toBeUndefined();
  });

  it('If-Match : valeur exacte, faible (W/), liste ou * acceptées ; sinon 412', () => {
    expect(code(() => verifierIfMatch('"42"', etag, 'console'))).toBeUndefined();
    expect(code(() => verifierIfMatch('W/"42"', etag, 'console'))).toBeUndefined();
    expect(code(() => verifierIfMatch('"41", "42"', etag, 'console'))).toBeUndefined();
    expect(code(() => verifierIfMatch('*', etag, 'console'))).toBeUndefined();
    expect(code(() => verifierIfMatch('"41"', etag, 'mobile'))).toBe('PRECONDITION_ECHOUEE');
    expect(code(() => verifierIfMatch('42', etag, 'console'))).toBe('PRECONDITION_ECHOUEE');
  });

  it('avecEtag : champ etag dans le corps, identique à l’en-tête', () => {
    const dto = avecEtag({ id: 'x' }, 7);
    expect(dto).toEqual({ id: 'x', etag: '"7"' });
    expect(JSON.parse(JSON.stringify(dto))).toEqual({ id: 'x', etag: '"7"' });
  });
});

describe('images (magic bytes, docs/04 §8)', () => {
  it('reconnaît PNG, JPEG et WebP par leur contenu', () => {
    expect(detecterTypeImage(IMAGES.png)?.type).toBe('image/png');
    expect(detecterTypeImage(IMAGES.jpeg)?.type).toBe('image/jpeg');
    expect(detecterTypeImage(IMAGES.webp)?.type).toBe('image/webp');
  });
  it('refuse un contenu usurpé (PDF, HTML, SVG, GIF)', () => {
    for (const faux of [
      '%PDF-1.7',
      '<html></html>',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'GIF89a......',
    ]) {
      expect(detecterTypeImage(Buffer.from(faux))).toBeNull();
    }
    expect(detecterTypeImage(Buffer.alloc(0))).toBeNull();
  });
});

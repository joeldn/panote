import { describe, it, expect } from 'vitest';
import { tilePath, manifestUrl, parseManifest } from './manifest.js';

describe('tilePath', () => {
  it('builds the tile URL from baseUrl, pano, level, face, x, y', () => {
    expect(tilePath('/tiles/', 'church', 2, 'px', 1, 3)).toBe('/tiles/church/2/px/1-3.jpg');
  });

  it('uses the supplied format extension', () => {
    expect(tilePath('/tiles/', 'church', 2, 'px', 1, 3, 'webp')).toBe(
      '/tiles/church/2/px/1-3.webp',
    );
  });
});

describe('manifestUrl', () => {
  it('builds the manifest URL', () => {
    expect(manifestUrl('/tiles/', 'church')).toBe('/tiles/church/manifest.json');
  });
});

describe('parseManifest', () => {
  const valid = {
    pano: 'church',
    faceSize: 8192,
    tileSize: 512,
    maxLevel: 4,
    faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'],
    quality: 70,
    format: 'webp' as const,
  };

  it('returns a typed manifest for valid input', () => {
    expect(parseManifest(valid)).toEqual(valid);
  });

  it('defaults format to jpg when field is absent', () => {
    const withoutFormat = {
      pano: valid.pano,
      faceSize: valid.faceSize,
      tileSize: valid.tileSize,
      maxLevel: valid.maxLevel,
      faces: valid.faces,
      quality: valid.quality,
    };
    expect(parseManifest(withoutFormat)).toEqual({
      ...withoutFormat,
      format: 'jpg',
    });
  });

  it('throws when format is an unsupported value', () => {
    expect(() => parseManifest({ ...valid, format: 'png' })).toThrow();
  });

  it('throws when faceSize !== tileSize * 2^maxLevel', () => {
    expect(() => parseManifest({ ...valid, maxLevel: 3 })).toThrow();
  });

  it('throws when faces are wrong', () => {
    expect(() => parseManifest({ ...valid, faces: ['px'] })).toThrow();
  });

  it('throws for zero tileSize', () => {
    expect(() => parseManifest({ ...valid, tileSize: 0, faceSize: 0 })).toThrow();
  });

  it('throws for out-of-range quality', () => {
    expect(() => parseManifest({ ...valid, quality: 0 })).toThrow();
  });

  it('throws for null', () => expect(() => parseManifest(null)).toThrow());

  it('throws for a non-object', () => expect(() => parseManifest('nope')).toThrow());

  it('throws for a non-string pano', () =>
    expect(() => parseManifest({ ...valid, pano: 42 })).toThrow());

  it('throws for a non-numeric tileSize', () =>
    expect(() => parseManifest({ ...valid, tileSize: '512' })).toThrow());

  it('throws for NaN quality', () =>
    expect(() => parseManifest({ ...valid, quality: NaN })).toThrow());

  it('throws for an empty pano string', () =>
    expect(() => parseManifest({ ...valid, pano: '' })).toThrow());

  it('throws for a blank/whitespace-only pano string', () =>
    expect(() => parseManifest({ ...valid, pano: '   ' })).toThrow());

  it('rejects a tiny tileSize even though faceSize/maxLevel are internally consistent', () => {
    // tileSize=1 with a small maxLevel drives selectLevel() to a huge grid
    // (6 * 4^level tileVisible checks/frame) regardless of maxLevel, so this
    // must be rejected even though faceSize === tileSize * 2^maxLevel holds
    // and maxLevel is well under the cap.
    expect(() => parseManifest({ ...valid, tileSize: 1, maxLevel: 14, faceSize: 2 ** 14 })).toThrow(
      /tileSize/,
    );
  });

  it('rejects a maxLevel above a sane pyramid depth even with a large tileSize', () => {
    // faceSize is kept within its own cap here so this exercises the maxLevel
    // check specifically, not the faceSize one (the two would otherwise
    // always fire together, since faceSize = tileSize * 2^maxLevel and
    // tileSize's floor is 512).
    expect(() => parseManifest({ ...valid, tileSize: 512, maxLevel: 6, faceSize: 16384 })).toThrow(
      /maxLevel/,
    );
  });

  it('rejects a tileSize that is not a power of two, even within range', () => {
    expect(() =>
      parseManifest({ ...valid, tileSize: 300, maxLevel: 5, faceSize: 300 * 2 ** 5 }),
    ).toThrow(/tileSize/);
  });

  it('rejects the gap the old bounds left: tileSize 128 forces a deep level to reach a passing faceSize', () => {
    // Under the old bounds (tileSize >= 128, maxLevel <= 8) this combination
    // passed validation while still driving tile-layer.ts's per-frame
    // visibility loop to level 7 (~19.3 ms/frame measured, well over a 60fps
    // budget). tileSize is no longer in the allowed set, so this must throw.
    expect(() => parseManifest({ ...valid, tileSize: 128, maxLevel: 7, faceSize: 16384 })).toThrow(
      /tileSize/,
    );
  });

  it('rejects a faceSize above the derived cap even when internally consistent', () => {
    expect(() =>
      parseManifest({ ...valid, tileSize: 1024, maxLevel: 5, faceSize: 1024 * 2 ** 5 }),
    ).toThrow(/faceSize/);
  });

  it('accepts the largest legitimate pyramid at tileSize 512', () => {
    expect(() =>
      parseManifest({ ...valid, tileSize: 512, maxLevel: 5, faceSize: 512 * 2 ** 5 }),
    ).not.toThrow();
  });

  it('accepts the largest legitimate pyramid at tileSize 1024', () => {
    expect(() =>
      parseManifest({ ...valid, tileSize: 1024, maxLevel: 4, faceSize: 1024 * 2 ** 4 }),
    ).not.toThrow();
  });
});

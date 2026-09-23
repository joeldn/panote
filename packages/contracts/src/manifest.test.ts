import { describe, it, expect } from 'vitest';
import { ManifestSchema } from './manifest.js';

describe('ManifestSchema', () => {
  const manifest = {
    pano: 'p1',
    faceSize: 4096,
    tileSize: 512,
    maxLevel: 3,
    faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'],
    quality: 70,
    format: 'webp',
  };

  it('accepts a well-formed manifest', () => {
    expect(ManifestSchema.parse(manifest).faces).toHaveLength(6);
  });

  it('rejects a manifest missing a required field', () => {
    const bad = {
      pano: 'p1',
      tileSize: 512,
      maxLevel: 3,
      faces: ['px'],
      quality: 70,
      format: 'webp',
    }; // no faceSize
    expect(() => ManifestSchema.parse(bad)).toThrow();
  });

  // These cases pin that ManifestSchema actually enforces every bound
  // parseManifest documents, not just claims to mirror it.

  it('rejects a face value that is not one of the six cube faces', () => {
    expect(() =>
      ManifestSchema.parse({ ...manifest, faces: ['banana', 'nx', 'py', 'ny', 'pz', 'nz'] }),
    ).toThrow();
  });

  it('rejects a format outside jpg/webp', () => {
    expect(() => ManifestSchema.parse({ ...manifest, format: 'gif' })).toThrow();
  });

  it('rejects a non-integer faceSize', () => {
    expect(() => ManifestSchema.parse({ ...manifest, faceSize: 4096.5 })).toThrow();
  });

  it('rejects a non-positive tileSize', () => {
    expect(() => ManifestSchema.parse({ ...manifest, tileSize: 0 })).toThrow();
  });

  it('rejects a negative maxLevel', () => {
    expect(() => ManifestSchema.parse({ ...manifest, maxLevel: -1 })).toThrow();
  });

  it('rejects a quality above 100', () => {
    expect(() => ManifestSchema.parse({ ...manifest, quality: 101 })).toThrow();
  });

  it('rejects a non-positive quality', () => {
    expect(() => ManifestSchema.parse({ ...manifest, quality: 0 })).toThrow();
  });

  it('rejects an empty pano id', () => {
    expect(() => ManifestSchema.parse({ ...manifest, pano: '' })).toThrow();
  });

  // Mirrors the checks parseManifest makes in packages/core/src/manifest.ts.

  describe('invariant parity with parseManifest', () => {
    it('rejects a tileSize outside the allowed set', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, tileSize: 256, faceSize: 4096, maxLevel: 4 }),
      ).toThrow();
    });

    it('rejects tileSize 128 even though faceSize 16384 is within its cap (maxLevel 7 separately exceeds MAX_LEVEL_CAP)', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, tileSize: 128, maxLevel: 7, faceSize: 16384 }),
      ).toThrow();
    });

    it('rejects a faceSize above the derived cap even when internally consistent', () => {
      expect(() =>
        ManifestSchema.parse({
          ...manifest,
          tileSize: 1024,
          maxLevel: 5,
          faceSize: 1024 * 2 ** 5,
        }),
      ).toThrow();
    });

    it('rejects a maxLevel above the derived cap', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, tileSize: 512, maxLevel: 6, faceSize: 16384 }),
      ).toThrow();
    });

    it('rejects faceSize !== tileSize * 2^maxLevel', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, tileSize: 512, maxLevel: 3, faceSize: 16384 }),
      ).toThrow();
    });

    it('rejects faces out of FACES order, even though every value is individually valid', () => {
      expect(() =>
        ManifestSchema.parse({
          ...manifest,
          faces: ['nx', 'px', 'py', 'ny', 'pz', 'nz'],
        }),
      ).toThrow();
    });

    it('rejects a faces array missing a member', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, faces: ['px', 'nx', 'py', 'ny', 'pz'] }),
      ).toThrow();
    });

    it('accepts the largest legitimate pyramid at tileSize 512', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, tileSize: 512, maxLevel: 5, faceSize: 16384 }),
      ).not.toThrow();
    });

    it('accepts the largest legitimate pyramid at tileSize 1024', () => {
      expect(() =>
        ManifestSchema.parse({ ...manifest, tileSize: 1024, maxLevel: 4, faceSize: 16384 }),
      ).not.toThrow();
    });
  });
});

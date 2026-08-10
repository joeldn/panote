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

  // The cases below were previously ACCEPTED by the loose schema
  // (`faces: z.array(z.string())`, `format: z.string()`, no numeric
  // constraints) and are now REJECTED, per the tightening documented in the
  // Manifest reconciliation (see src/manifest.ts). This is a deliberate
  // behaviour change, not a regression.

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
});

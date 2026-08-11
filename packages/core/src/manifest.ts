import { FACES, type Face } from './geometry.js';

export type TileFormat = 'jpg' | 'webp';

export interface Manifest {
  pano: string;
  faceSize: number;
  tileSize: number;
  maxLevel: number;
  faces: readonly Face[];
  quality: number;
  format: TileFormat;
}

export function tilePath(
  baseUrl: string,
  pano: string,
  level: number,
  face: string,
  x: number,
  y: number,
  format: TileFormat = 'jpg',
): string {
  // baseUrl is a base URL, not a path segment - it must not be encoded, or a
  // scheme/host/existing path would be mangled. pano and face are untrusted
  // path segments and are encoded individually so neither can inject an
  // extra "/" (or other URL-significant character) into the resulting path.
  return `${baseUrl}${encodeURIComponent(pano)}/${level}/${encodeURIComponent(face)}/${x}-${y}.${format}`;
}

export function manifestUrl(baseUrl: string, pano: string): string {
  return `${baseUrl}${encodeURIComponent(pano)}/manifest.json`;
}

// These bounds are derived, not provisional guesses — see docs/decisions.md.
// faceSize and maxLevel bound two *different* quantities, and a cap on only
// one of them does not compose with tileSize: a prior version of this file
// bounded tileSize >= 128 and maxLevel <= 8, and {tileSize: 128, maxLevel: 7,
// faceSize: 16384} passed both checks while still driving tile-layer.ts's
// per-frame visibility loop (6 * 4^level `tileVisible` checks) to ~19.3
// ms/frame — well over a 60fps budget. The fix is to bound faceSize directly
// (it is also the storage/spend lever: bytes scale as faceSize^2) and to
// bound maxLevel independently (it is what the per-frame loop actually scales
// with), then restrict tileSize to the two values that reach the faceSize cap
// exactly with no wasted headroom: 512*2^5 = 1024*2^4 = 16384.
//
// Exported so the tiler (the write side of this invariant) enforces the exact
// same bounds instead of maintaining its own copy that could drift.
export const ALLOWED_TILE_SIZES = [512, 1024] as const;
export const MAX_FACE_SIZE = 16384;
export const MAX_LEVEL_CAP = 5;

// Mirrors the write-time check the tiler enforces on opts.pano (see
// packages/tiler/src/build.ts, commit 6b8c363). Every legitimate pano is a
// developer-typed slug or a generated id and already satisfies this, so
// enforcing it here too is a read-time backstop: it rejects a manifest whose
// pano diverges from what the tiler would ever have written (e.g. one
// containing "/" or ".."), before that value is ever interpolated into a
// tile URL by tilePath()/manifestUrl(). encodeURIComponent below still runs
// regardless, so a pano that somehow bypassed this (a future relaxation of
// the pattern) still can't break the URL structure - this is defence in
// depth, not the only guard.
const PANO_PATTERN = /^[A-Za-z0-9_-]+$/;

export function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('manifest must be an object');
  }
  const m = raw as Record<string, unknown>;
  const num = (k: string): number => {
    if (typeof m[k] !== 'number') throw new Error(`manifest.${k} must be a number`);
    return m[k];
  };
  const pano = m.pano;
  if (typeof pano !== 'string' || pano.trim().length === 0)
    throw new Error('manifest.pano must be a non-empty string');
  if (!PANO_PATTERN.test(pano)) throw new Error('manifest.pano must match /^[A-Za-z0-9_-]+$/');
  const faceSize = num('faceSize');
  const tileSize = num('tileSize');
  const maxLevel = num('maxLevel');
  const quality = num('quality');
  if (!Number.isInteger(tileSize) || tileSize <= 0)
    throw new Error('manifest.tileSize must be a positive integer');
  if (!(ALLOWED_TILE_SIZES as readonly number[]).includes(tileSize))
    throw new Error(`manifest.tileSize must be one of ${ALLOWED_TILE_SIZES.join(', ')}`);
  if (!Number.isInteger(faceSize) || faceSize <= 0)
    throw new Error('manifest.faceSize must be a positive integer');
  if (faceSize > MAX_FACE_SIZE) throw new Error(`manifest.faceSize must be <= ${MAX_FACE_SIZE}`);
  if (!Number.isInteger(maxLevel) || maxLevel < 0)
    throw new Error('manifest.maxLevel must be a non-negative integer');
  if (maxLevel > MAX_LEVEL_CAP) throw new Error(`manifest.maxLevel must be <= ${MAX_LEVEL_CAP}`);
  if (!Number.isFinite(quality) || quality <= 0 || quality > 100)
    throw new Error('manifest.quality must be a finite number in (0, 100]');
  if (faceSize !== tileSize * 2 ** maxLevel) {
    throw new Error('manifest.faceSize must equal tileSize * 2^maxLevel');
  }
  // Compared element-wise (not via a joined-string comparison) so that a
  // single-element array like ['px,nx,py,ny,pz,nz'] - which joins to the
  // exact same string as the real FACES array - is correctly rejected
  // instead of passing as a false positive.
  const faces = m.faces;
  if (
    !Array.isArray(faces) ||
    faces.length !== FACES.length ||
    !FACES.every((face, i) => faces[i] === face)
  ) {
    throw new Error(`manifest.faces must equal ${FACES.join(',')}`);
  }
  const rawFormat = m.format ?? 'jpg';
  if (rawFormat !== 'jpg' && rawFormat !== 'webp') {
    throw new Error(`manifest.format must be 'jpg' or 'webp' (got ${String(rawFormat)})`);
  }
  const format: TileFormat = rawFormat;
  return { pano, faceSize, tileSize, maxLevel, faces: FACES, quality, format };
}

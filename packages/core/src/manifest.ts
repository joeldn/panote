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
  return `${baseUrl}${pano}/${level}/${face}/${x}-${y}.${format}`;
}

export function manifestUrl(baseUrl: string, pano: string): string {
  return `${baseUrl}${pano}/manifest.json`;
}

// The two real levers on tile-layer.ts's per-frame visibility loop (which runs
// 6 * 4^level `tileVisible` checks) are maxLevel and tileSize — and tileSize is
// the dangerous one: selectLevel() already clamps the *chosen* level by field
// of view, so a large maxLevel with a sane tileSize is harmless, but a tiny
// tileSize forces selectLevel to pick a very deep level regardless of maxLevel
// (e.g. tileSize=1, maxLevel=14 drives ~1.6e9 iterations/frame). A tileSize
// floor closes that off; the maxLevel cap is a second, independent bound with
// generous headroom over what the tiler can ever emit (<=5 at its 150MP cap).
const MIN_TILE_SIZE = 128;
const MAX_TILE_SIZE = 4096;
const MAX_LEVEL_CAP = 8;

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
  const faceSize = num('faceSize');
  const tileSize = num('tileSize');
  const maxLevel = num('maxLevel');
  const quality = num('quality');
  if (!Number.isInteger(tileSize) || tileSize <= 0)
    throw new Error('manifest.tileSize must be a positive integer');
  if (tileSize < MIN_TILE_SIZE || tileSize > MAX_TILE_SIZE || (tileSize & (tileSize - 1)) !== 0)
    throw new Error(
      `manifest.tileSize must be a power of two in [${MIN_TILE_SIZE}, ${MAX_TILE_SIZE}]`,
    );
  if (!Number.isInteger(faceSize) || faceSize <= 0)
    throw new Error('manifest.faceSize must be a positive integer');
  if (!Number.isInteger(maxLevel) || maxLevel < 0)
    throw new Error('manifest.maxLevel must be a non-negative integer');
  if (maxLevel > MAX_LEVEL_CAP) throw new Error(`manifest.maxLevel must be <= ${MAX_LEVEL_CAP}`);
  if (!Number.isFinite(quality) || quality <= 0 || quality > 100)
    throw new Error('manifest.quality must be a finite number in (0, 100]');
  if (faceSize !== tileSize * 2 ** maxLevel) {
    throw new Error('manifest.faceSize must equal tileSize * 2^maxLevel');
  }
  if (!Array.isArray(m.faces) || m.faces.join(',') !== FACES.join(',')) {
    throw new Error(`manifest.faces must equal ${FACES.join(',')}`);
  }
  const rawFormat = m.format ?? 'jpg';
  if (rawFormat !== 'jpg' && rawFormat !== 'webp') {
    throw new Error(`manifest.format must be 'jpg' or 'webp' (got ${String(rawFormat)})`);
  }
  const format: TileFormat = rawFormat;
  return { pano, faceSize, tileSize, maxLevel, faces: FACES, quality, format };
}

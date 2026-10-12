/**
 * Reference implementations the tests check the viewer against. Simple and
 * allocating where the production code is written for speed, and not part of
 * the package.
 */
import { tilesPerEdge } from '../cube.js';
import { dirInto, type Vec3 } from '../project.js';
import { projectDirInto, type Mat4 } from '../render/projection.js';
import { pickEvictions, type EvictCandidate } from '../tile-cache.js';
import type { TileRetryBudget } from '../tile-retry.js';

/** Unit direction for a (yaw, pitch), matching the camera convention. */
export function dirFromYawPitch(yaw: number, pitch: number): Vec3 {
  return dirInto({ x: 0, y: 0, z: 0 }, yaw, pitch);
}

/** Direction → NDC, as a new object. */
export function projectDir(dir: Vec3, viewProj: Mat4): Vec3 {
  return projectDirInto({ x: 0, y: 0, z: 0 }, dir, viewProj);
}

/** A tile's four UV corners in top-left, top-right, bottom-left, bottom-right order. */
export function tileCornersUV(
  level: number,
  x: number,
  y: number,
): [
  { u: number; v: number },
  { u: number; v: number },
  { u: number; v: number },
  { u: number; v: number },
] {
  const g = tilesPerEdge(level);
  const u0 = x / g;
  const v0 = y / g;
  const u1 = (x + 1) / g;
  const v1 = (y + 1) / g;
  return [
    { u: u0, v: v0 },
    { u: u1, v: v0 },
    { u: u0, v: v1 },
    { u: u1, v: v1 },
  ];
}

/**
 * The keys pickEvictions chooses to bring `entries` down to `maxTiles`,
 * oldest first: level-0 tiles and tiles used in `currentFrame` never go.
 */
export function selectEvictions(
  entries: EvictCandidate[],
  maxTiles: number,
  currentFrame?: number,
): string[] {
  return pickEvictions(entries, entries.length - maxTiles, currentFrame, []).map((e) => e.key);
}

/** Attempts `budget` has spent on the tile `key` so far (0 when it has never failed). */
export function attemptsFor(budget: TileRetryBudget, key: string): number {
  const { attempts } = budget as unknown as { attempts: Map<string, { count: number }> };
  return attempts.get(key)?.count ?? 0;
}

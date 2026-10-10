import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Manifest } from '@panote/core';
import * as cube from './cube.js';
import * as projection from './render/projection.js';
import { TileLayer } from './tile-layer.js';
import { RADIUS } from './tile-geometry.js';
import { dirFromYawPitch } from './project.js';
import type { GLRenderer } from './render/gl-renderer.js';

// The cull's geometry and frustum calls are wrapped in spies, so these tests
// can count the work a frame does: how many spheres it tests, whether it
// rebuilt the frustum at all, and whether it recomputed any tile corners.
vi.mock('./cube.js', async (importOriginal) => {
  const actual = await importOriginal<typeof cube>();
  return { ...actual, faceUVToDir: vi.fn(actual.faceUVToDir) };
});
vi.mock('./render/projection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof projection>();
  return {
    ...actual,
    frustumFromViewProj: vi.fn(actual.frustumFromViewProj),
    intersectsSphere: vi.fn(actual.intersectsSphere),
  };
});

const TILE_SIZE = 512;
const MAX_LEVEL = 5;

function manifest(): Manifest {
  return {
    pano: 'pano-a',
    faceSize: TILE_SIZE * 2 ** MAX_LEVEL,
    tileSize: TILE_SIZE,
    maxLevel: MAX_LEVEL,
    faces: cube.FACES,
    quality: 82,
    format: 'jpg',
  };
}

/** Viewport height at which selectLevel lands exactly on `level` for `fov`. */
const heightFor = (level: number, fov: number): number => (TILE_SIZE * fov * 2 ** level) / 90;

/** Small deterministic PRNG, so a failing view can be reproduced. */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every tile at `level` tested on its own: the answer the hierarchical cull
 * must reproduce. Same sphere (flat-quad corners, padded 5 %, stored as
 * float32) and the same plane test.
 */
function bruteForce(viewProj: Float32Array, level: number): Set<string> {
  const frustum = projection.frustumFromViewProj(viewProj);
  const g = cube.tilesPerEdge(level);
  const out = new Set<string>();
  for (const face of cube.FACES) {
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const p = cube.tileCornersUV(level, x, y).map((c) => {
          const d = cube.faceUVToDir(face, c.u, c.v);
          return [d.x * RADIUS, d.y * RADIUS, d.z * RADIUS] as const;
        });
        const cx = (p[0]![0] + p[1]![0] + p[2]![0] + p[3]![0]) / 4;
        const cy = (p[0]![1] + p[1]![1] + p[2]![1] + p[3]![1]) / 4;
        const cz = (p[0]![2] + p[1]![2] + p[2]![2] + p[3]![2]) / 4;
        const r = Math.max(...p.map((q) => Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz)));
        const sphere = {
          cx: Math.fround(cx),
          cy: Math.fround(cy),
          cz: Math.fround(cz),
          r: Math.fround(r * 1.05),
        };
        if (projection.intersectsSphere(frustum, sphere)) out.add(`${level}/${face}/${x}-${y}`);
      }
    }
  }
  return out;
}

describe('TileLayer cull', () => {
  let layer: TileLayer;

  beforeEach(() => {
    // Fetches never settle: only what update() decides is under test here.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    layer = new TileLayer(
      { uploadTile: vi.fn(() => 1), removeTile: vi.fn() } as unknown as GLRenderer,
      manifest(),
      '/tiles/',
      512,
      () => {},
      8,
      () => 0,
      () => Promise.resolve(),
    );
  });

  afterEach(() => {
    layer.dispose();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const desired = (): Set<string> => (layer as unknown as { desired: Set<string> }).desired;

  function frame(yaw: number, pitch: number, fov: number, aspect: number, level: number) {
    const viewProj = projection.viewProjection({ yaw, pitch, fov }, aspect, 179);
    const vfov = projection.effectiveVFovDeg(fov, 179, aspect);
    layer.update(viewProj, vfov, dirFromYawPitch(yaw, pitch), heightFor(level, vfov));
    return viewProj;
  }

  it('finds exactly the tiles a brute-force test of every tile finds', () => {
    const random = rng(7);
    for (let n = 0; n < 20; n++) {
      const level = 3 + (n % 3);
      const yaw = random() * Math.PI * 2;
      const pitch = (random() - 0.5) * 2.8;
      const fov = 30 + random() * 50;
      const aspect = 0.5 + random() * 1.5;
      const viewProj = frame(yaw, pitch, fov, aspect, level);
      const expected = bruteForce(viewProj, level);
      expect(expected.size).toBeGreaterThan(0);
      expect(desired()).toEqual(expected);
    }
  });

  it('skips the subtrees outside the view instead of testing every tile', () => {
    const spheres = vi.mocked(projection.intersectsSphere);
    spheres.mockClear();
    frame(0, 0, 40, 1, 5);
    // 6 × 4^5 = 6144 tiles at level 5; descending tests a small fraction.
    expect(spheres.mock.calls.length).toBeLessThan(6144 / 8);
    expect(desired().size).toBeGreaterThan(0);
  });

  it('reuses the visible set when neither the view nor the level changed', () => {
    frame(0.3, 0.1, 70, 16 / 9, 4);
    const before = new Set(desired());
    vi.mocked(projection.frustumFromViewProj).mockClear();
    vi.mocked(projection.intersectsSphere).mockClear();
    for (let i = 0; i < 5; i++) frame(0.3, 0.1, 70, 16 / 9, 4);
    expect(projection.frustumFromViewProj).not.toHaveBeenCalled();
    expect(projection.intersectsSphere).not.toHaveBeenCalled();
    expect(desired()).toEqual(before);
    // A different view culls again.
    frame(0.4, 0.1, 70, 16 / 9, 4);
    expect(projection.frustumFromViewProj).toHaveBeenCalledTimes(1);
  });

  it('computes tile geometry once per level, not once per frame', () => {
    frame(0, 0, 70, 16 / 9, 4);
    const faceUVToDir = vi.mocked(cube.faceUVToDir);
    faceUVToDir.mockClear();
    for (let i = 0; i < 24; i++) frame((i * Math.PI) / 12, 0.2, 70, 16 / 9, 4);
    expect(faceUVToDir).not.toHaveBeenCalled();
  });
});

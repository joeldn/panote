import { describe, it, expect, vi } from 'vitest';
import { faceUVToDir, tileCornersUV, type Face } from './cube.js';
import { TileLayer } from './tile-layer.js';
import type { CubeTileSource, TileAddress } from './source.js';
import { effectiveVFovDeg, viewProjection } from './render/projection.js';
import { dirFromYawPitch } from './project.js';
import type { GLRenderer } from './render/gl-renderer.js';

// A view of many tiles on a slow link takes many rounds of requests. The
// tiles nearest the centre go first; behind the first rounds of them, the
// rest of the view gets a coarse fallback (the grandparent from level 3, the
// parent at level 2), so its edges leave the base long before their own tiles
// land. These tests drive the queue one completed request at a time, as a
// link that is the bottleneck would, and read the order the requests went in.

interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

const LAPTOP: Viewport = { width: 1512, height: 982, dpr: 2 }; // level 3, 76 tiles
const DESKTOP: Viewport = { width: 1920, height: 1080, dpr: 1 }; // level 2, 24 tiles
const PHONE: Viewport = { width: 390, height: 844, dpr: 2 }; // level 2, 8 tiles

const tileId = (t: TileAddress): string => `${t.level}/${t.face}/${t.x}-${t.y}`;
const levelOf = (key: string): number => Number(key.split('/')[0]);

/** 1 - cos of the angle between the view axis (yaw 0) and the tile's centre. */
function offCentre(key: string): number {
  const [l, face, xy] = key.split('/') as [string, Face, string];
  const [x, y] = xy.split('-').map(Number) as [number, number];
  const c = tileCornersUV(Number(l), x, y);
  const d = faceUVToDir(face, (c[0]!.u + c[1]!.u) / 2, (c[0]!.v + c[2]!.v) / 2);
  const f = dirFromYawPitch(0, 0);
  return 1 - (d.x * f.x + d.y * f.y + d.z * f.z) / Math.hypot(d.x, d.y, d.z);
}

const ancestor = (key: string, up: number): string => {
  const [l, face, xy] = key.split('/') as [string, string, string];
  const [x, y] = xy.split('-').map(Number) as [number, number];
  return `${Number(l) - up}/${face}/${x >> up}-${y >> up}`;
};

/**
 * Load the base, then show `vp` at yaw 0 and complete one request at a time,
 * oldest first, until nothing is left. Returns the tiles the view wanted and
 * every request after the base, in the order they went out.
 */
async function loadView(
  vp: Viewport,
  maxConcurrent: number,
): Promise<{ desired: string[]; requests: string[]; level: number }> {
  let clock = 0;
  const requests: string[] = [];
  const held: (() => void)[] = [];
  const source: CubeTileSource = {
    id: 'pano',
    tileSize: 512,
    maxLevel: 3,
    loadTile: (t) =>
      new Promise((resolve) => {
        const bitmap = { width: 512, height: 512, close: vi.fn() } as unknown as ImageBitmap;
        if (t.level === 0) {
          resolve(bitmap);
          return;
        }
        requests.push(tileId(t));
        held.push(() => resolve(bitmap));
      }),
  };
  const renderer = { uploadTile: vi.fn(() => 1), removeTile: vi.fn() };
  const layer = new TileLayer(renderer as unknown as GLRenderer, source, () => {}, {
    textureBudgetMB: 256,
    maxConcurrent,
    now: () => clock,
  });
  await layer.loadBase();
  const aspect = vp.width / vp.height;
  const viewProj = viewProjection({ yaw: 0, pitch: 0, fov: 70 }, aspect, 100);
  const vfov = effectiveVFovDeg(70, 100, aspect);
  const frame = (): void => {
    clock += 1000 / 60;
    layer.update(viewProj, vfov, dirFromYawPitch(0, 0), Math.floor(vp.height * vp.dpr));
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  frame();
  const internals = layer as unknown as { desired: Set<string>; visibleLevel: number };
  const desired = [...internals.desired];
  const level = internals.visibleLevel;
  for (let i = 0; i < 1000 && (held.length > 0 || layer.hasPending()); i++) {
    held.shift()?.();
    await flush();
    frame();
  }
  expect(layer.hasPending()).toBe(false);
  layer.dispose();
  return { desired, requests, level };
}

describe('TileLayer: coarse fallback for a large view', () => {
  it('fetches grandparents behind the first three rounds of centre tiles, ahead of the edges', async () => {
    const maxConcurrent = 8;
    const { desired, requests, level } = await loadView(LAPTOP, maxConcurrent);
    expect(level).toBe(3);
    expect(desired.length).toBe(76);
    const lead = 3 * maxConcurrent;
    // Ranked against the whole view, not against what is left to request.
    const ranked = [...desired].sort((a, b) => offCentre(a) - offCentre(b));
    const leadTiles = new Set(ranked.slice(0, lead));
    const fallbacks = requests.filter((k) => levelOf(k) < level);

    // Present: grandparents, and only grandparents.
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const k of fallbacks) expect(levelOf(k)).toBe(1);
    // Never ahead of the first rounds: every lead tile went before any fallback.
    const firstFallback = requests.indexOf(fallbacks[0]!);
    for (const k of leadTiles) expect(requests.indexOf(k)).toBeLessThan(firstFallback);
    // Ahead of the edges: no edge tile went before the last fallback.
    const lastFallback = requests.indexOf(fallbacks.at(-1)!);
    const before = requests.slice(0, lastFallback).filter((k) => levelOf(k) === level);
    expect(before.every((k) => leadTiles.has(k))).toBe(true);
    // Each one stands in for edge tiles, and no request is repeated.
    const edges = ranked.slice(lead);
    for (const k of fallbacks) expect(edges.some((e) => ancestor(e, 2) === k)).toBe(true);
    expect(new Set(requests).size).toBe(requests.length);
    // Every tile in view still loads.
    for (const k of desired) expect(requests).toContain(k);
  });

  it('fetches parents behind the first rounds when level 2 is the target', async () => {
    const maxConcurrent = 2;
    const { desired, requests, level } = await loadView(DESKTOP, maxConcurrent);
    expect(level).toBe(2);
    expect(desired.length).toBe(24);
    const lead = 3 * maxConcurrent;
    const ranked = [...desired].sort((a, b) => offCentre(a) - offCentre(b));
    const fallbacks = requests.filter((k) => levelOf(k) < level);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const k of fallbacks) expect(levelOf(k)).toBe(1);
    const firstFallback = requests.indexOf(fallbacks[0]!);
    for (const k of ranked.slice(0, lead)) expect(requests.indexOf(k)).toBeLessThan(firstFallback);
  });

  it('fetches no fallback when the edges beyond the first rounds fit in two more', async () => {
    // 76 tiles against 32 slots: three rounds of 32 already take them all.
    const laptop = await loadView(LAPTOP, 32);
    expect(laptop.requests.filter((k) => levelOf(k) < laptop.level)).toEqual([]);
    expect(laptop.requests.length).toBe(laptop.desired.length);
    // 24 tiles against 8 slots: the three lead rounds are the whole view.
    const desktop = await loadView(DESKTOP, 8);
    expect(desktop.requests.filter((k) => levelOf(k) < desktop.level)).toEqual([]);
    expect(desktop.requests.length).toBe(24);
    // 24 tiles against 5 slots: 15 lead, and 9 edge tiles are under two rounds.
    const tight = await loadView(DESKTOP, 5);
    expect(tight.requests.filter((k) => levelOf(k) < tight.level)).toEqual([]);
    expect(tight.requests.length).toBe(24);
    const phone = await loadView(PHONE, 8);
    expect(phone.requests.every((k) => levelOf(k) === phone.level)).toBe(true);
    expect(phone.requests.length).toBe(phone.desired.length);
  });
});

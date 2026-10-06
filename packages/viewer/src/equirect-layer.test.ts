import { describe, it, expect, vi } from 'vitest';
import { FACES, dirToEquirectUV, faceUVToDir, type Vec3 } from '@panote/core';
import {
  EquirectLayer,
  PREVIEW_GUTTER_PX,
  PREVIEW_LEVEL,
  buildEquirectPatchGeometry,
  patchCoreRects,
  type PreviewPatch,
  type PreviewSource,
} from './equirect-layer.js';
import type { TileGeometry } from './tile-geometry.js';
import { dirFromYawPitch } from './project.js';

const G = PREVIEW_GUTTER_PX;

type FakeImage = { width: number; height: number; close: ReturnType<typeof vi.fn> };

function fakeImage(width: number, height: number): FakeImage {
  return { width, height, close: vi.fn() };
}

/** A cols × rows grid over width × height, with a G px gutter on every interior edge. */
function gridSource(width: number, height: number, cols: number, rows: number): PreviewSource {
  const patches: PreviewPatch[] = [];
  const cw = width / cols;
  const rh = height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.max(0, c * cw - G);
      const y = Math.max(0, r * rh - G);
      const x1 = Math.min(width, (c + 1) * cw + G);
      const y1 = Math.min(height, (r + 1) * rh + G);
      const image = fakeImage(x1 - x, y1 - y) as unknown as ImageBitmap;
      patches.push({ x, y, w: x1 - x, h: y1 - y, image });
    }
  }
  return { width, height, patches };
}

function fakeRenderer(maxTextureSize = 16384) {
  let next = 1;
  const uploads: { handle: number; geom: TileGeometry }[] = [];
  return {
    maxTextureSize,
    uploads,
    uploadTile: vi.fn((geom: TileGeometry) => {
      const handle = next++;
      uploads.push({ handle, geom });
      return handle;
    }),
    removeTile: vi.fn(),
  };
}

// Source pixel the preview shows for `dir`: ray-cast the meshes and interpolate
// UV barycentrically, as the GPU's perspective-correct interpolation does.
function previewSourcePixel(
  source: PreviewSource,
  geoms: TileGeometry[],
  raw: Vec3,
): { x: number; y: number } | undefined {
  const len = Math.hypot(raw.x, raw.y, raw.z);
  const dir = { x: raw.x / len, y: raw.y / len, z: raw.z / len };
  for (let p = 0; p < geoms.length; p++) {
    const geom = geoms[p]!;
    const { pos, uv, index } = geom;
    const centres = centroids(geom);
    const patch = source.patches[p]!;
    const v = (i: number): Vec3 => ({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! });
    for (let t = 0; t < index.length; t += 3) {
      // Cull triangles whose centre is more than ~2° from the ray (they span < 1.5°).
      if (dir.x * centres[t]! + dir.y * centres[t + 1]! + dir.z * centres[t + 2]! < 0.9994)
        continue;
      const a = index[t]!;
      const b = index[t + 1]!;
      const c = index[t + 2]!;
      const hit = rayTriangle(dir, v(a), v(b), v(c));
      if (!hit) continue;
      const w0 = 1 - hit.u - hit.v;
      const s = w0 * uv[a * 2]! + hit.u * uv[b * 2]! + hit.v * uv[c * 2]!;
      const r = w0 * uv[a * 2 + 1]! + hit.u * uv[b * 2 + 1]! + hit.v * uv[c * 2 + 1]!;
      return { x: patch.x + s * patch.w, y: patch.y + r * patch.h };
    }
  }
  return undefined;
}

const centroidCache = new WeakMap<TileGeometry, Float64Array>();
function centroids(geom: TileGeometry): Float64Array {
  let out = centroidCache.get(geom);
  if (out) return out;
  const { pos, index } = geom;
  out = new Float64Array(index.length);
  for (let t = 0; t < index.length; t += 3) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let j = 0; j < 3; j++) {
      const i = index[t + j]! * 3;
      x += pos[i]!;
      y += pos[i + 1]!;
      z += pos[i + 2]!;
    }
    const l = Math.hypot(x, y, z);
    out[t] = x / l;
    out[t + 1] = y / l;
    out[t + 2] = z / l;
  }
  centroidCache.set(geom, out);
  return out;
}

// Möller–Trumbore from the origin; returns barycentrics of the hit, if any.
function rayTriangle(d: Vec3, a: Vec3, b: Vec3, c: Vec3): { u: number; v: number } | undefined {
  const sub = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
  const cross = (p: Vec3, q: Vec3): Vec3 => ({
    x: p.y * q.z - p.z * q.y,
    y: p.z * q.x - p.x * q.z,
    z: p.x * q.y - p.y * q.x,
  });
  const dot = (p: Vec3, q: Vec3) => p.x * q.x + p.y * q.y + p.z * q.z;
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const pv = cross(d, e2);
  const det = dot(e1, pv);
  if (Math.abs(det) < 1e-12) return undefined;
  const tv = { x: -a.x, y: -a.y, z: -a.z };
  const u = dot(tv, pv) / det;
  const qv = cross(tv, e1);
  const v = dot(d, qv) / det;
  const eps = 1e-9;
  if (u < -eps || v < -eps || u + v > 1 + eps) return undefined;
  if (dot(e2, qv) / det <= 0) return undefined;
  return { u, v };
}

describe('preview / tiler sampling parity', () => {
  // renderFace (packages/tiler/src/remap.ts) samples each face pixel at
  // dirToEquirectUV(faceUVToDir(face, u, v)) * (W, H); the preview must agree.
  const W = 8000;
  const H = 4000;
  const source = gridSource(W, H, 2, 1);
  const renderer = fakeRenderer();
  new EquirectLayer(renderer, source);
  const geoms = renderer.uploads.map((u) => u.geom);

  function expectParity(dir: Vec3): void {
    const tiler = dirToEquirectUV(dir);
    const got = previewSourcePixel(source, geoms, dir);
    expect(got).toBeDefined();
    // Wrap x so the 0/1 seam compares as one place.
    let dx = got!.x - tiler.u * W;
    dx -= Math.round(dx / W) * W;
    // A pixel of u spans cos(latitude) of a pixel's angle, so compare on the
    // sphere. The mesh is piecewise flat, which costs at most ~0.2 px at 8000 wide.
    const lat = (0.5 - tiler.v) * Math.PI;
    expect(Math.hypot(dx * Math.cos(lat), got!.y - tiler.v * H)).toBeLessThan(0.25);
  }

  it('samples the same source pixel as renderFace for every face', () => {
    const N = 5;
    for (const face of FACES) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          expectParity(faceUVToDir(face, (i + 0.5) / N, (j + 0.5) / N));
        }
      }
    }
  });

  it('samples the same source pixel as renderFace for sample yaw/pitch views', () => {
    const yaws = [-3.1, -1.5, -0.3, 0, 0.001, 0.7, 1.57, 2.9];
    const pitches = [-1.5, -0.9, -0.2, 0, 0.35, 1.1, 1.5];
    for (const yaw of yaws) for (const pitch of pitches) expectParity(dirFromYawPitch(yaw, pitch));
  });

  it('puts the camera’s forward view (yaw 0, pitch 0) on the source centre', () => {
    const got = previewSourcePixel(source, geoms, dirFromYawPitch(0, 0))!;
    expect(got.x).toBeCloseTo(W / 2, 3);
    expect(got.y).toBeCloseTo(H / 2, 3);
  });
});

describe('patchCoreRects', () => {
  it('meets in the middle of each gutter overlap, leaving no gap and no double cover', () => {
    const src = gridSource(2048, 1024, 2, 2);
    const cores = patchCoreRects(src.patches);
    expect(cores).toEqual([
      { x0: 0, y0: 0, x1: 1024, y1: 512 },
      { x0: 1024, y0: 0, x1: 2048, y1: 512 },
      { x0: 0, y0: 512, x1: 1024, y1: 1024 },
      { x0: 1024, y0: 512, x1: 2048, y1: 1024 },
    ]);
  });

  it('leaves abutting patches and single patches untouched', () => {
    expect(
      patchCoreRects([
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 100, y: 0, w: 100, h: 50 },
      ]),
    ).toEqual([
      { x0: 0, y0: 0, x1: 100, y1: 50 },
      { x0: 100, y0: 0, x1: 200, y1: 50 },
    ]);
  });
});

describe('buildEquirectPatchGeometry', () => {
  it('keeps a whole-sphere patch within 16-bit indices', () => {
    const rect = { x: 0, y: 0, w: 4096, h: 2048 };
    const g = buildEquirectPatchGeometry(4096, 2048, rect, { x0: 0, y0: 0, x1: 4096, y1: 2048 });
    const count = g.pos.length / 3;
    expect(count).toBeLessThanOrEqual(65536);
    expect(g.uv.length).toBe(count * 2);
    expect(g.index.reduce((m, i) => Math.max(m, i), 0)).toBe(count - 1);
  });

  it('addresses the patch image with v = 0 on its top row', () => {
    const patch = { x: 1000, y: 500, w: 200, h: 100 };
    const g = buildEquirectPatchGeometry(2048, 1024, patch, {
      x0: 1002,
      y0: 502,
      x1: 1198,
      y1: 598,
    });
    // First vertex is the core's top-left: 2 px into the image on each axis.
    expect(g.uv[0]).toBeCloseTo(2 / 200, 9);
    expect(g.uv[1]).toBeCloseTo(2 / 100, 9);
    // And it sits above the horizon (y > 0), since the core is in the top half.
    expect(g.pos[1]).toBeGreaterThan(0);
  });
});

describe('EquirectLayer', () => {
  it('uploads one texture per patch and draws them below level 0', () => {
    const r = fakeRenderer();
    const layer = new EquirectLayer(r, gridSource(8000, 4000, 2, 1));
    expect(r.uploadTile).toHaveBeenCalledTimes(2);
    expect(layer.drawList()).toEqual([
      { handle: 1, level: PREVIEW_LEVEL },
      { handle: 2, level: PREVIEW_LEVEL },
    ]);
    expect(PREVIEW_LEVEL).toBeLessThan(0);
  });

  it('closes each bitmap once it is uploaded', () => {
    const source = gridSource(2048, 1024, 2, 1);
    new EquirectLayer(fakeRenderer(), source);
    for (const p of source.patches) {
      expect((p.image as unknown as FakeImage).close).toHaveBeenCalledTimes(1);
    }
  });

  it('frees every texture on dispose, once', () => {
    const r = fakeRenderer();
    const layer = new EquirectLayer(r, gridSource(2048, 1024, 2, 2));
    layer.dispose();
    expect(r.removeTile.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4]);
    expect(layer.drawList()).toEqual([]);
    layer.dispose();
    expect(r.removeTile).toHaveBeenCalledTimes(4);
  });

  it('rejects a patch larger than the GPU allows, uploading and keeping nothing', () => {
    const r = fakeRenderer(2048);
    const source = gridSource(8192, 4096, 2, 1);
    expect(() => new EquirectLayer(r, source)).toThrow(/exceeds the 2048px limit/);
    expect(r.uploadTile).not.toHaveBeenCalled();
    for (const p of source.patches) {
      expect((p.image as unknown as FakeImage).close).toHaveBeenCalled();
    }
  });

  it('caps patches at 4096 px even when the GPU allows more', () => {
    const source = gridSource(8192, 4096, 1, 1);
    expect(() => new EquirectLayer(fakeRenderer(16384), source)).toThrow(/4096px limit/);
  });

  it('rejects an already closed bitmap', () => {
    const source = gridSource(2048, 1024, 1, 1);
    (source.patches[0]!.image as unknown as FakeImage).width = 0;
    expect(() => new EquirectLayer(fakeRenderer(), source)).toThrow(/already closed/);
  });

  it('rejects a patch outside the source and an empty source', () => {
    const image = fakeImage(10, 10) as unknown as ImageBitmap;
    expect(
      () =>
        new EquirectLayer(fakeRenderer(), {
          width: 100,
          height: 50,
          patches: [{ x: 95, y: 0, w: 10, h: 10, image }],
        }),
    ).toThrow(/outside 100x50/);
    expect(
      () => new EquirectLayer(fakeRenderer(), { width: 100, height: 50, patches: [] }),
    ).toThrow(/no patches/);
  });

  it('frees what it uploaded when a later upload fails', () => {
    const r = fakeRenderer();
    r.uploadTile
      .mockImplementationOnce(() => 7)
      .mockImplementationOnce(() => {
        throw new Error('context lost');
      });
    expect(() => new EquirectLayer(r, gridSource(2048, 1024, 2, 1))).toThrow('context lost');
    expect(r.removeTile).toHaveBeenCalledWith(7);
  });
});

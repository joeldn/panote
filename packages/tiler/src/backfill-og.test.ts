import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import type { Manifest } from '@panote/core';
import { backfillOg, ogLevel, type OgStore } from './backfill-og.js';
import { build } from './build.js';
import { OG_HEIGHT, OG_VIEW, OG_WIDTH } from './og.js';

// Same idea as og.test.ts's labelled equirect, kept local so neither test file
// depends on the other: each pixel is coloured by the cube face its direction
// falls on (yaw 0 = -z = nz, yaw +90° = +x = px).
const NZ: [number, number, number] = [30, 220, 220];
const OTHER: [number, number, number] = [220, 30, 30];
async function writeLabelledEquirect(path: string, w: number, h: number): Promise<void> {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const pitch = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const yaw = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const dx = Math.sin(yaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * Math.cos(pitch);
      const nz = dz < 0 && -dz >= Math.abs(dx) && -dz >= Math.abs(dy);
      data.set(nz ? NZ : OTHER, (y * w + x) * 3);
    }
  }
  await sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(path);
}

const PANO = 'pano-a';
const VERSION = 't1-abc';
const MANIFEST_KEY = (p: string) => `tiles/${p}/manifest.json`;
const keys = {
  manifest: MANIFEST_KEY,
  versionDir: (p: string, v: string | undefined) =>
    v === undefined ? `tiles/${p}/` : `tiles/${p}/${v}/`,
};

/** The files a pre-OG tiler run left in R2: everything but og.jpg, and no `og` flag. */
let legacyObjects: Map<string, Uint8Array>;
let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'panote-og-backfill-'));
  const src = join(work, 'src.png');
  // 4096 wide -> faceSize 1024 -> maxLevel 1, so faces are stitched from 2x2 tiles.
  await writeLabelledEquirect(src, 4096, 2048);
  await build({ src, outDir: work, pano: PANO, version: VERSION });
  legacyObjects = new Map();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else legacyObjects.set(relative(join(work, PANO), p), new Uint8Array(await readFile(p)));
    }
  };
  await walk(join(work, PANO));
  expect(legacyObjects.has('og.jpg')).toBe(true);
  legacyObjects.delete('og.jpg');
  const manifest = JSON.parse(new TextDecoder().decode(legacyObjects.get('manifest.json'))) as {
    og?: true;
  };
  delete manifest.og;
  // A field this script doesn't know about must survive its manifest rewrite.
  const legacy = { ...manifest, futureField: 'keep me' };
  legacyObjects.set('manifest.json', new TextEncoder().encode(JSON.stringify(legacy)));
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

interface Put {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

/** An in-memory bucket holding `panos` as the legacy tiler run left them. */
function fakeStore(panos: string[] = [PANO]) {
  const objects = new Map<string, Uint8Array>();
  for (const p of panos)
    for (const [rel, body] of legacyObjects) {
      if (rel === 'manifest.json') {
        const m = JSON.parse(new TextDecoder().decode(body)) as Manifest;
        objects.set(MANIFEST_KEY(p), new TextEncoder().encode(JSON.stringify({ ...m, pano: p })));
      } else objects.set(`tiles/${p}/${VERSION}/${rel}`, body);
    }
  const puts: Put[] = [];
  const gets: string[] = [];
  const store: OgStore = {
    get: vi.fn(async (key: string) => {
      gets.push(key);
      return objects.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, body: Uint8Array, contentType: string, cacheControl: string) => {
      puts.push({ key, body, contentType, cacheControl });
      objects.set(key, body);
    }),
  };
  const manifestOf = (p: string) =>
    JSON.parse(new TextDecoder().decode(objects.get(MANIFEST_KEY(p)))) as Record<string, unknown>;
  return { store, objects, puts, gets, manifestOf };
}

const quiet = () => {};

describe('ogLevel', () => {
  const m = (tileSize: number, maxLevel: number) =>
    ({ tileSize, maxLevel, faceSize: tileSize * 2 ** maxLevel }) as Manifest;

  it('picks the smallest level at least as sharp as the render needs', () => {
    // The default view needs a ~2014px face: 512 * 2^2 = 2048.
    expect(ogLevel(m(512, 5), OG_VIEW)).toBe(2);
    expect(ogLevel(m(1024, 4), OG_VIEW)).toBe(1);
  });

  it('settles for the top level when the pyramid is smaller than that', () => {
    expect(ogLevel(m(512, 1), OG_VIEW)).toBe(1);
    expect(ogLevel(m(512, 0), OG_VIEW)).toBe(0);
  });
});

describe('backfillOg', () => {
  it('dry run: reports what it would render and writes nothing, reading only manifests', async () => {
    const { store, puts, gets } = fakeStore();
    const results = await backfillOg({ store, keys, panos: [PANO], dryRun: true, log: quiet });
    expect(results).toEqual([
      { pano: PANO, status: 'would-render', detail: expect.stringMatching(/level 1.*12 tiles/) },
    ]);
    expect(puts).toEqual([]);
    expect(gets).toEqual([MANIFEST_KEY(PANO)]);
  }, 30_000);

  it('renders og.jpg from the tiles, then flags the manifest, keeping its other fields', async () => {
    const { store, puts, manifestOf } = fakeStore();
    const before = manifestOf(PANO);
    const results = await backfillOg({ store, keys, panos: [PANO], dryRun: false, log: quiet });
    expect(results).toEqual([{ pano: PANO, status: 'rendered', detail: expect.any(String) }]);

    expect(puts.map((p) => p.key)).toEqual([`tiles/${PANO}/${VERSION}/og.jpg`, MANIFEST_KEY(PANO)]);
    const [og, manifest] = puts;
    expect(og!.contentType).toBe('image/jpeg');
    expect(og!.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(manifest!.contentType).toBe('application/json');
    expect(manifest!.cacheControl).toBe('public, max-age=30');
    expect(manifestOf(PANO)).toEqual({ ...before, og: true });
    expect(manifestOf(PANO).futureField).toBe('keep me');

    const meta = await sharp(og!.body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', OG_WIDTH, OG_HEIGHT]);
    const { data } = await sharp(og!.body).raw().toBuffer({ resolveWithObject: true });
    const centre = (OG_HEIGHT / 2) * OG_WIDTH * 3 + (OG_WIDTH / 2) * 3;
    const rgb = [data[centre], data[centre + 1], data[centre + 2]];
    rgb.forEach((c, i) => expect(Math.abs(c! - NZ[i]!)).toBeLessThan(30));
  }, 30_000);

  it('matches the tiler’s own og.jpg closely (same view, same convention)', async () => {
    const { store, puts } = fakeStore();
    await backfillOg({ store, keys, panos: [PANO], dryRun: false, log: quiet });
    const direct = await readFile(join(work, PANO, 'og.jpg'));
    const a = await sharp(puts[0]!.body).raw().toBuffer();
    const b = await sharp(direct).raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!);
    expect(diff / a.length).toBeLessThan(4);
  }, 30_000);

  it('skips a pano that already has og.jpg, and one with no manifest', async () => {
    const { store, puts, objects } = fakeStore(['done', 'gone']);
    const m = JSON.parse(new TextDecoder().decode(objects.get(MANIFEST_KEY('done')))) as object;
    objects.set(MANIFEST_KEY('done'), new TextEncoder().encode(JSON.stringify({ ...m, og: true })));
    objects.delete(MANIFEST_KEY('gone'));
    const results = await backfillOg({
      store,
      keys,
      panos: ['done', 'gone'],
      dryRun: false,
      log: quiet,
    });
    expect(results).toEqual([
      { pano: 'done', status: 'skipped', detail: 'already has og.jpg' },
      { pano: 'gone', status: 'skipped', detail: 'no manifest' },
    ]);
    expect(puts).toEqual([]);
  });

  it('fails a pano with a missing tile or a bad manifest, and carries on with the rest', async () => {
    const { store, objects, puts } = fakeStore(['broken', 'bad', 'fine']);
    objects.delete(`tiles/broken/${VERSION}/1/nz/0-0.webp`);
    objects.set(MANIFEST_KEY('bad'), new TextEncoder().encode('{"pano":"bad"}'));
    const results = await backfillOg({
      store,
      keys,
      panos: ['broken', 'bad', 'fine'],
      dryRun: false,
      log: quiet,
    });
    expect(results.map((r) => [r.pano, r.status])).toEqual([
      ['broken', 'failed'],
      ['bad', 'failed'],
      ['fine', 'rendered'],
    ]);
    expect(results[0]!.detail).toMatch(/1\/nz\/0-0\.webp/);
    expect(puts.map((p) => p.key)).toEqual([`tiles/fine/${VERSION}/og.jpg`, MANIFEST_KEY('fine')]);
  }, 30_000);

  it('leaves the manifest alone when a re-tile replaced it mid-render', async () => {
    const { store, objects, puts } = fakeStore();
    const get = store.get;
    let manifestReads = 0;
    store.get = async (key) => {
      const body = await get(key);
      if (key === MANIFEST_KEY(PANO) && ++manifestReads === 2 && body) {
        const m = JSON.parse(new TextDecoder().decode(body)) as object;
        return new TextEncoder().encode(JSON.stringify({ ...m, version: 't1-newer' }));
      }
      return body;
    };
    const results = await backfillOg({ store, keys, panos: [PANO], dryRun: false, log: quiet });
    expect(results).toEqual([
      { pano: PANO, status: 'skipped', detail: expect.stringMatching(/changed while rendering/) },
    ]);
    expect(puts.map((p) => p.key)).not.toContain(MANIFEST_KEY(PANO));
    expect(objects.has(MANIFEST_KEY(PANO))).toBe(true);
  }, 30_000);

  it('logs one line per pano', async () => {
    const { store } = fakeStore();
    const log = vi.fn();
    await backfillOg({ store, keys, panos: [PANO], dryRun: true, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(PANO));
  }, 30_000);
});

// Keeps the fixture honest: the legacy objects really are a multi-tile pyramid.
it('fixture is a maxLevel-1 pyramid with 2x2 tiles per face', async () => {
  expect(legacyObjects.has('1/nz/1-1.webp')).toBe(true);
  expect((await stat(join(work, PANO, 'og.jpg'))).size).toBeGreaterThan(0);
});

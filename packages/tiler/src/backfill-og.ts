import sharp from 'sharp';
import { parseManifest, tilesPerEdge, type Face, type Manifest } from '@panote/core';
import {
  cubeSampler,
  facesInView,
  OG_FILE,
  OG_VIEW,
  ogFaceSize,
  ogImage,
  type View,
} from './og.js';
import type { RgbImage } from './remap.js';

/** The bucket, as the backfill needs it. */
export interface OgStore {
  /** The object and its ETag (as the store sends it), or null for a missing key. */
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  /**
   * Writes the object. With `ifMatch`, only while the object still has that ETag:
   * resolves false when it doesn't (R2 answers 412), true once written.
   */
  put(
    key: string,
    body: Uint8Array,
    contentType: string,
    cacheControl: string,
    ifMatch?: string,
  ): Promise<boolean>;
}

/** Where a pano's manifest and its version dir (ending in `/`) live. */
export interface OgKeys {
  manifest(pano: string): string;
  versionDir(pano: string, version: string | undefined): string;
}

export interface BackfillOptions {
  store: OgStore;
  keys: OgKeys;
  panos: readonly string[];
  /** Reads manifests only; writes nothing and fetches no tiles. */
  dryRun: boolean;
  log?: ((msg: string) => void) | undefined;
  /** Tile GETs in flight at once. */
  concurrency?: number | undefined;
}

export interface BackfillResult {
  pano: string;
  status: 'rendered' | 'would-render' | 'skipped' | 'failed';
  detail: string;
}

// Same cache headers the tiler container writes (services/tiler-consumer/src/container.ts).
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE = 'public, max-age=30';

/** The smallest pyramid level whose faces are as sharp as the og render needs, or the top one. */
export function ogLevel(manifest: Pick<Manifest, 'tileSize' | 'maxLevel'>, view: View): number {
  const need = ogFaceSize(view);
  for (let level = 0; level < manifest.maxLevel; level++)
    if (manifest.tileSize * tilesPerEdge(level) >= need) return level;
  return manifest.maxLevel;
}

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Stitches one face at `level` back together from its tiles. */
async function loadFace(
  store: OgStore,
  dir: string,
  manifest: Manifest,
  level: number,
  face: Face,
  concurrency: number,
): Promise<RgbImage> {
  const { tileSize, format } = manifest;
  const perEdge = tilesPerEdge(level);
  const size = tileSize * perEdge;
  const data = Buffer.alloc(size * size * 3);
  const coords = Array.from({ length: perEdge * perEdge }, (_, i) => ({
    tx: i % perEdge,
    ty: Math.floor(i / perEdge),
  }));
  await mapLimit(coords, concurrency, async ({ tx, ty }) => {
    const key = `${dir}${level}/${face}/${tx}-${ty}.${format}`;
    const got = await store.get(key);
    if (!got) throw new Error(`missing tile ${key}`);
    const { data: tile, info } = await sharp(got.body)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== tileSize || info.height !== tileSize || info.channels !== 3)
      throw new Error(`tile ${key} is ${info.width}x${info.height}x${info.channels}`);
    const rowBytes = tileSize * 3;
    for (let y = 0; y < tileSize; y++) {
      const src = y * rowBytes;
      const dst = ((ty * tileSize + y) * size + tx * tileSize) * 3;
      tile.copy(data, dst, src, src + rowBytes);
    }
  });
  return { data, width: size, height: size, channels: 3 };
}

async function backfillOne(
  pano: string,
  opts: BackfillOptions,
  concurrency: number,
): Promise<BackfillResult> {
  const { store, keys } = opts;
  const raw = await store.get(keys.manifest(pano));
  if (!raw) return { pano, status: 'skipped', detail: 'no manifest' };
  const json = decode(raw.body) as Record<string, unknown>;
  const manifest = parseManifest(json);
  if (manifest.og) return { pano, status: 'skipped', detail: 'already has og.jpg' };

  const view = OG_VIEW;
  const level = ogLevel(manifest, view);
  const faces = facesInView(view);
  const tiles = faces.length * tilesPerEdge(level) ** 2;
  const plan = `level ${level} (${manifest.tileSize * tilesPerEdge(level)}px faces), ${faces.join('/')}, ${tiles} tiles`;
  if (opts.dryRun) return { pano, status: 'would-render', detail: plan };

  const dir = keys.versionDir(pano, manifest.version);
  const loaded: Partial<Record<Face, RgbImage>> = {};
  for (const face of faces)
    loaded[face] = await loadFace(store, dir, manifest, level, face, concurrency);
  const jpeg = await ogImage(cubeSampler(loaded), view).toBuffer();
  await store.put(`${dir}${OG_FILE}`, new Uint8Array(jpeg), 'image/jpeg', IMMUTABLE);

  // A re-tile can land while this ran; its manifest names a new version dir that
  // has its own og.jpg, so only flag the manifest this render was made for. The
  // PUT is conditional on the re-read's ETag, so a re-tile that lands between the
  // re-read and the write can't be rolled back to the old tiles.
  const changed = {
    pano,
    status: 'skipped',
    detail: 'manifest changed while rendering; left as is',
  } as const;
  const again = await store.get(keys.manifest(pano));
  const current = again ? (decode(again.body) as Record<string, unknown>) : null;
  if (!again || !current || current.version !== json.version || current.og !== undefined)
    return changed;
  const written = await store.put(
    keys.manifest(pano),
    new TextEncoder().encode(JSON.stringify({ ...current, og: true }, null, 2)),
    'application/json',
    MANIFEST_CACHE,
    again.etag,
  );
  if (!written) return changed;
  return { pano, status: 'rendered', detail: `${plan}, ${(jpeg.length / 1024).toFixed(0)} KB` };
}

/**
 * Gives panos tiled before og.jpg existed a link-preview image: re-renders it from
 * their existing tiles (no original needed), writes it into the version dir, then
 * adds `og: true` to the manifest. Panos are done one at a time; a failure is
 * recorded and the rest carry on. Safe to re-run: flagged panos are skipped.
 */
export async function backfillOg(opts: BackfillOptions): Promise<BackfillResult[]> {
  const log = opts.log ?? (() => {});
  const concurrency = opts.concurrency ?? 16;
  const results: BackfillResult[] = [];
  for (const pano of opts.panos) {
    let result: BackfillResult;
    try {
      result = await backfillOne(pano, opts, concurrency);
    } catch (e) {
      result = { pano, status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
    log(`${result.status.padEnd(12)} ${pano}  ${result.detail}`);
    results.push(result);
  }
  return results;
}

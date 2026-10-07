import { vi } from 'vitest';
import type {
  DecodedPreview,
  FetchLike,
  PreviewDecoder,
  PreviewSource,
  XhrLike,
} from '@internal/web-kit';

export const TILES = 'https://cdn.test/tiles/';
export const PUT_URL = 'https://r2.test/put?X-Amz-SignedHeaders=content-type%3Bhost';

/** A recorded request to the fake backend. */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  cache: RequestCache | undefined;
}

export const manifest = (version: string, pano = 'pano-1') => ({
  pano,
  faceSize: 1024,
  tileSize: 512,
  maxLevel: 1,
  faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'],
  quality: 85,
  format: 'webp',
  version,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The admin API, presign route and CDN manifest as one fake fetch. Tests steer it
 * through `state` (manifest queue, tiling status, forced failures).
 */
export function fakeBackend() {
  const state = {
    calls: [] as Call[],
    /** Manifest responses in order (null = 404); the last one repeats. */
    manifests: [null] as Array<ReturnType<typeof manifest> | null>,
    tiling: 'pending' as 'pending' | 'failed' | 'ready' | 'none',
    tour: { tourId: 'tour-1', title: 'Town hall', scenes: [] as Array<{ panoId: string }> },
    tourEtag: 't1',
    /** Stored pano configs, as the editor's `?include=configs` load returns them. */
    configs: {} as Record<string, { title: string }>,
    hasConfig: false,
    presignStatus: 200,
    statusStatus: 200,
    createTourStatus: 201,
    getTourStatus: 200,
    /** The panoId the presign hands a new pano. */
    newPanoId: 'pano-1',
    /** Panos the tour publish reports as `not-ready` (a 422); empty publishes. */
    publishNotReady: [] as string[],
    /** What the library listing (`GET /api/admin/panos`) returns. */
    library: [] as Array<Record<string, unknown>>,
  };

  const fetch: FetchLike = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    // The dashboard's own list reads (it sits under /app/new); not part of the upload.
    if (method === 'GET' && /^\/api\/admin\/(tours|panos)(\?|$)/.test(path)) {
      return path.startsWith('/api/admin/tours')
        ? json({ tours: [], cursor: null })
        : json({
            panoIds: state.library.map((p) => p.panoId),
            panos: state.library,
            cursor: null,
          });
    }
    // The editor's own load of the tour (it sits under /app/t/:id); not part of the upload.
    if (method === 'GET' && /\?include=configs$/.test(path)) {
      if (!path.startsWith('/api/admin/tours/tour-1')) return json({ error: 'not found' }, 404);
      const configs: Record<string, unknown> = {};
      for (const { panoId } of state.tour.scenes) {
        const c = state.configs[panoId];
        configs[panoId] = c
          ? { config: { panoId, title: c.title, hotspots: [] }, etag: `c-${panoId}` }
          : { missing: true, deleting: false, hasOriginal: true };
      }
      return json({ tour: state.tour, etag: state.tourEtag, configs });
    }
    state.calls.push({ method, url, headers, body, cache: init.cache });

    if (url.startsWith(TILES)) {
      const next = state.manifests.length > 1 ? state.manifests.shift() : state.manifests[0];
      return next ? json(next, 200, { 'cache-control': 'public, max-age=30' }) : json({}, 404);
    }
    if (method === 'POST' && path === '/api/upload-url') {
      if (state.presignStatus !== 200) return json({ error: 'nope' }, state.presignStatus);
      const req = body as { panoId?: string };
      const panoId = req.panoId ?? state.newPanoId;
      return json({ panoId, key: `panos/o/${panoId}/original`, url: PUT_URL });
    }
    if (method === 'POST' && path === '/api/admin/tours') {
      if (state.createTourStatus !== 201) return json({ error: 'nope' }, state.createTourStatus);
      state.tour = { ...(body as typeof state.tour), tourId: 'tour-1' };
      return json({ tourId: 'tour-1' }, 201);
    }
    if (method === 'GET' && /^\/api\/admin\/panos\/[^/?]+\?status=1$/.test(path)) {
      if (state.statusStatus !== 200) return json({ error: 'nope' }, state.statusStatus);
      return json({
        status: {
          hasConfig: state.hasConfig,
          hasOriginal: true,
          deleting: false,
          tiling: state.tiling,
          manifest: null,
          updatedAt: '2026-10-01T00:00:00Z',
        },
      });
    }
    if (method === 'GET' && /^\/api\/admin\/panos\/[^/?]+$/.test(path)) {
      return json({ error: 'config not found', deleting: false, hasOriginal: true }, 404);
    }
    if (method === 'PUT' && /^\/api\/admin\/panos\/[^/]+\/config$/.test(path)) {
      if (headers['if-none-match'] === '*' && state.hasConfig)
        return json({ error: 'conflict' }, 412);
      state.hasConfig = true;
      const panoId = path.split('/')[4]!;
      state.configs[panoId] ??= { title: (body as { title: string }).title };
      return json({ etag: 'c1' });
    }
    if (method === 'POST' && path === '/api/admin/tours/tour-1/publish') {
      if (state.publishNotReady.length > 0) {
        const scenes = state.publishNotReady.map((panoId) => ({ panoId, reason: 'not-ready' }));
        return json({ error: 'scenes not publishable', scenes }, 422);
      }
      return json({
        slug: 'town-hall',
        visibility: 'unlisted',
        publishedAt: '2026-10-01T00:00:00.000Z',
        url: '/s/town-hall',
      });
    }
    if (method === 'GET' && path === '/api/admin/tours/tour-1') {
      if (state.getTourStatus !== 200) return json({ error: 'nope' }, state.getTourStatus);
      return json({ tour: state.tour, etag: state.tourEtag }, 200, { etag: `"${state.tourEtag}"` });
    }
    if (method === 'DELETE' && path === '/api/admin/tours/tour-1') {
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && path === '/api/admin/tours/tour-1') {
      if (headers['if-match'] !== `"${state.tourEtag}"`) return json({ error: 'conflict' }, 412);
      state.tour = body as typeof state.tour;
      state.tourEtag = `t${Number(state.tourEtag.slice(1)) + 1}`;
      return json({ etag: state.tourEtag });
    }
    return json({ error: 'not found' }, 404);
  };

  const callsTo = (pred: (c: Call) => boolean) => state.calls.filter(pred);
  return {
    state,
    fetch,
    /** Readiness polls (and replace baselines); not the cache refresh once ready. */
    manifestPolls: () => callsTo((c) => c.url.startsWith(TILES) && c.cache !== 'reload'),
    /** The `cache: 'reload'` refetch once a pano is ready, so the viewer's copy is fresh. */
    manifestRefreshes: () => callsTo((c) => c.url.startsWith(TILES) && c.cache === 'reload'),
    presigns: () => callsTo((c) => c.url.endsWith('/api/upload-url')),
    writes: () => callsTo((c) => c.method === 'PUT'),
  };
}

/** A scriptable XMLHttpRequest for the presigned PUT. */
export class FakeXhr implements XhrLike {
  static all: FakeXhr[] = [];
  static get last(): FakeXhr {
    const x = FakeXhr.all[FakeXhr.all.length - 1];
    if (!x) throw new Error('no XHR sent');
    return x;
  }

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: Blob | null = null;
  status = 0;
  aborted = false;
  upload: XhrLike['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: Blob) {
    this.body = body;
    FakeXhr.all.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

/** A PNG with a real IHDR (so the pixel check can read it), padded to `size` bytes. */
export function pngFile(name = 'Town_hall.png', width = 8000, height = 4000, size = 2000): File {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return new File([b], name, { type: 'image/png' });
}

/** An in-memory stand-in for the IndexedDB pending-upload stash; it outlives a re-render. */
export function fakePending(initial: File | null = null, initialOwner: string | null = null) {
  let file = initial;
  let owner = initialOwner;
  return {
    stash: vi.fn(async (f: File, who: string) => {
      file = f;
      owner = who;
      return true;
    }),
    // Same rule as web-kit's takePendingUpload: someone else's stash is dropped unused.
    take: vi.fn(async (who: string | null) => {
      const f = owner === null || owner === who ? file : null;
      file = null;
      owner = null;
      return f;
    }),
    clear: vi.fn(async () => {
      file = null;
      owner = null;
    }),
    // Same rule as web-kit's clearForeignPendingUpload (minus the age check).
    dropForeign: vi.fn(async (who: string) => {
      if (owner !== null && owner !== who) {
        file = null;
        owner = null;
      }
    }),
    peek: () => file,
  };
}

/**
 * Stands in for the preview worker: every decode is a new one-patch source, labelled by
 * what it decoded (`file` for the picked file, `stash` for the stash image it returns).
 */
export function fakeDecoder(opts: { fail?: boolean } = {}) {
  const stash = new Blob(['stash'], { type: 'image/webp' });
  const sources: Array<PreviewSource & { from: string }> = [];
  const decode = vi.fn<PreviewDecoder>(async (blob, options): Promise<DecodedPreview | null> => {
    if (opts.fail) throw new Error('preview decode failed: corrupt JPEG');
    const image = { width: 8, height: 4, close: vi.fn() } as unknown as ImageBitmap;
    const source = {
      from: blob === stash ? 'stash' : 'file',
      width: 8,
      height: 4,
      patches: [{ x: 0, y: 0, w: 8, h: 4, image }],
    };
    sources.push(source);
    return {
      source,
      stash: options.stash === false ? null : stash,
      stats: { sourceWidth: 8, sourceHeight: 4, resize: 'none', decodeMs: 0, totalMs: 0 },
    };
  });
  return { decode, sources, stash };
}

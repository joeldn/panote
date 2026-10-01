import { vi } from 'vitest';
import type { FetchLike, XhrLike } from '@internal/web-kit';

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
    hasConfig: false,
    presignStatus: 200,
    statusStatus: 200,
    createTourStatus: 201,
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
        : json({ panoIds: [], panos: [], cursor: null });
    }
    // The editor's own load of the tour (it sits under /app/t/:id); not part of the upload.
    if (method === 'GET' && /\?include=configs$/.test(path)) {
      return path.startsWith('/api/admin/tours/tour-1')
        ? json({ tour: state.tour, etag: state.tourEtag, configs: {} })
        : json({ error: 'not found' }, 404);
    }
    state.calls.push({ method, url, headers, body, cache: init.cache });

    if (url.startsWith(TILES)) {
      const next = state.manifests.length > 1 ? state.manifests.shift() : state.manifests[0];
      return next ? json(next, 200, { 'cache-control': 'public, max-age=30' }) : json({}, 404);
    }
    if (method === 'POST' && path === '/api/upload-url') {
      if (state.presignStatus !== 200) return json({ error: 'nope' }, state.presignStatus);
      const req = body as { panoId?: string };
      return json({ panoId: req.panoId ?? 'pano-1', key: 'panos/o/pano-1/original', url: PUT_URL });
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
      return json({ etag: 'c1' });
    }
    if (method === 'GET' && path === '/api/admin/tours/tour-1') {
      return json({ tour: state.tour, etag: state.tourEtag }, 200, { etag: `"${state.tourEtag}"` });
    }
    if (method === 'DELETE' && path === '/api/admin/tours/tour-1') {
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && path === '/api/admin/tours/tour-1') {
      state.tour = body as typeof state.tour;
      state.tourEtag = 't2';
      return json({ etag: 't2' });
    }
    return json({ error: 'not found' }, 404);
  };

  const callsTo = (pred: (c: Call) => boolean) => state.calls.filter(pred);
  return {
    state,
    fetch,
    manifestPolls: () => callsTo((c) => c.url.startsWith(TILES)),
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
    peek: () => file,
  };
}

import type { ViewerFactory } from '@internal/ui';
import type { FetchLike } from '@internal/web-kit';
import { vi } from 'vitest';

// In-memory admin-api for the editor tests: tour + configs with ETags and If-Match
// semantics (412 on a stale ETag, `*` unconditional), plus a scriptable publish.

export interface StoredDoc {
  etag: string;
  body: Record<string, unknown>;
}

export interface Recorded {
  method: string;
  path: string;
  ifMatch: string | null;
  ifNoneMatch: string | null;
  body: unknown;
}

export type PublishScript = () => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export class FakeServer {
  tour: StoredDoc | null = null;
  configs = new Map<string, StoredDoc>();
  /** Missing-config flags for panos with no stored config. */
  missing = new Map<string, { deleting: boolean; hasOriginal: boolean }>();
  publish: { slug: string; visibility: 'public' | 'unlisted'; publishedAt: string } | null = null;
  publishScript: PublishScript | null = null;
  requests: Recorded[] = [];
  /** Config PUTs for these panoIds fail with a 500. */
  brokenConfigs = new Set<string>();
  /** Answers every request with 401 while set (a session that died mid-edit). */
  unauthorized = false;
  /** What `?status=1` reports per pano (default `ready`). */
  tiling = new Map<string, 'ready' | 'pending' | 'failed' | 'none'>();
  /** What `GET /api/admin/panos` lists (the library picker), one page. */
  library: Array<Record<string, unknown>> = [];
  /** The library listing fails with a 500 while set. */
  libraryBroken = false;
  /** Sees each request first; a returned Response answers it instead (await to hold it). */
  intercept: ((r: Recorded) => Promise<Response | void> | Response | void) | null = null;
  private n = 0;

  nextEtag(): string {
    this.n += 1;
    return `etag-${this.n}`;
  }

  setTour(body: Record<string, unknown>): void {
    this.tour = { etag: this.nextEtag(), body };
  }

  setConfig(panoId: string, body: Record<string, unknown>): void {
    this.configs.set(panoId, { etag: this.nextEtag(), body: { panoId, ...body } });
  }

  writes(): Recorded[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  fetch: FetchLike = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'https://panote.test');
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const ifMatch = headers['If-Match'] ?? null;
    const ifNoneMatch = headers['If-None-Match'] ?? null;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, ifMatch, ifNoneMatch, body });
    if (this.unauthorized) return json({ error: 'unauthorized' }, 401);
    if (this.intercept) {
      const res = await this.intercept(this.requests.at(-1)!);
      if (res) return res;
    }

    if (url.pathname === '/api/admin/panos' && method === 'GET') {
      if (this.libraryBroken) return json({ error: 'boom' }, 500);
      const panoIds = this.library.map((p) => p.panoId);
      return json({ panoIds, panos: this.library, cursor: null });
    }

    const tourMatch = /^\/api\/admin\/tours\/([^/]+)(\/publish)?$/.exec(url.pathname);
    const panoMatch = /^\/api\/admin\/panos\/([^/]+)(\/config)?$/.exec(url.pathname);
    const stale = (doc: StoredDoc | undefined | null) =>
      ifMatch !== '*' && (!doc || ifMatch !== `"${doc.etag}"`);

    if (tourMatch && tourMatch[2] && method === 'POST') {
      if (this.publishScript) return this.publishScript();
      this.publish ??= {
        slug: 'my-tour',
        visibility: 'unlisted',
        publishedAt: '2026-10-01T00:00:00.000Z',
      };
      return json({ ...this.publish, url: `/s/${this.publish.slug}` });
    }
    if (tourMatch && method === 'GET') {
      if (!this.tour) return json({ error: 'not found' }, 404);
      const res: Record<string, unknown> = {
        tour: this.tour.body,
        etag: this.tour.etag,
        publish: this.publish,
      };
      if (url.searchParams.get('include') === 'configs') {
        const configs: Record<string, unknown> = {};
        for (const s of this.tour.body.scenes as Array<{ panoId: string }>) {
          const c = this.configs.get(s.panoId);
          configs[s.panoId] = c
            ? { config: c.body, etag: c.etag }
            : {
                missing: true,
                ...(this.missing.get(s.panoId) ?? { deleting: false, hasOriginal: false }),
              };
        }
        res.configs = configs;
      }
      return json(res);
    }
    if (tourMatch && method === 'PUT') {
      if (!ifMatch) return json({ error: 'If-Match required' }, 428);
      if (stale(this.tour)) return json({ error: 'conflict' }, 412);
      this.tour = { etag: this.nextEtag(), body: { ...(body as object), tourId: tourMatch[1] } };
      return json({ etag: this.tour.etag });
    }
    if (panoMatch && !panoMatch[2] && method === 'GET' && url.searchParams.get('status') === '1') {
      const tiling = this.tiling.get(panoMatch[1]!) ?? 'ready';
      const status = {
        hasConfig: this.configs.has(panoMatch[1]!),
        hasOriginal: tiling !== 'none',
        deleting: false,
        tiling,
        manifest: tiling === 'ready' ? { version: 'v-ready', format: 'webp', tileSize: 512 } : null,
        updatedAt: '2026-10-01T00:00:00.000Z',
      };
      return json({ status });
    }
    if (url.hostname !== 'panote.test') {
      // The tiles CDN (a manifest refresh once a pano is ready).
      return json({}, 200);
    }
    if (panoMatch && !panoMatch[2] && method === 'GET') {
      const c = this.configs.get(panoMatch[1]!);
      if (!c) {
        const flags = this.missing.get(panoMatch[1]!) ?? { deleting: false, hasOriginal: false };
        return json({ error: 'config not found', ...flags }, 404);
      }
      const status = {
        hasConfig: true,
        hasOriginal: true,
        deleting: false,
        tiling: 'ready',
        manifest: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
      };
      return json({ config: c.body, etag: c.etag, status });
    }
    if (panoMatch && panoMatch[2] && method === 'PUT') {
      const panoId = panoMatch[1]!;
      if (this.brokenConfigs.has(panoId)) return json({ error: 'boom' }, 500);
      // Same rules as admin-api: If-None-Match: * is create-only, If-Match: * unconditional.
      if (ifNoneMatch !== null) {
        if (ifMatch !== null || ifNoneMatch !== '*') return json({ error: 'bad' }, 400);
        if (this.configs.has(panoId)) return json({ error: 'conflict' }, 412);
      } else {
        if (!ifMatch) return json({ error: 'If-Match required' }, 428);
        if (stale(this.configs.get(panoId))) return json({ error: 'conflict' }, 412);
      }
      const doc = { etag: this.nextEtag(), body: { ...(body as object), panoId } };
      this.configs.set(panoId, doc);
      this.missing.delete(panoId);
      return json({ etag: doc.etag });
    }
    return json({ error: 'unexpected' }, 500);
  });
}

type Handler = (payload: string) => void;

/** jsdom has no WebGL: a PanoViewer stand-in with a scriptable view. */
export class FakeViewer {
  view = { yaw: 0, pitch: 0, fov: 70 };
  /** What directionAtPixel returns (where a placed point lands). */
  pointAt = { yaw: 0.5, pitch: 0.1 };
  handlers = new Map<string, Set<Handler>>();
  load = vi.fn(async (pano: string) => this.emit('scene-change', pano));
  transitionTo = vi.fn(async (pano: string) => this.emit('scene-change', pano));
  setView = vi.fn((v: Partial<{ yaw: number; pitch: number; fov: number }>) => {
    this.view = { ...this.view, ...v };
  });
  getView = () => ({ ...this.view });
  isSettled = () => false;
  directionAtPixel = vi.fn(() => ({ ...this.pointAt }));
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  showPreview = vi.fn();
  dispose = vi.fn();
  onRender = () => () => {};
  project = () => ({ x: 0, y: 0, behind: false });
  heading = () => 0;
  // Like PanoViewer: reporting an open emits it, so onHotspotOpen handlers run.
  reportHotspotOpen = vi.fn((id: string) => this.emit('hotspot-open', id));
  on = (type: string, fn: Handler) => {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
  };
  off = (type: string, fn: Handler) => this.handlers.get(type)?.delete(fn);
  emit(type: string, payload: string) {
    this.handlers.get(type)?.forEach((fn) => fn(payload));
  }
}

export function viewerFactory(): { create: ViewerFactory; viewers: FakeViewer[] } {
  const viewers: FakeViewer[] = [];
  const create: ViewerFactory = () => {
    const v = new FakeViewer();
    viewers.push(v);
    return v as unknown as ReturnType<ViewerFactory>;
  };
  return { create, viewers };
}

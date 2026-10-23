import type { PanoViewerEvents, ViewerFactory } from '@internal/ui';
import { loadConfig, type Auth, type Auth0Like } from '@internal/web-kit';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { fakeAuth, LOCAL } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { page, reloadOnPreloadError } from '../chunk-reload.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { createSiteAuth } from '../site-auth.js';
import { shareChunk } from './share-chunk.js';
import { StageFactoryContext } from './stage-factory.js';

type ViewerOptions = Parameters<ViewerFactory>[1];
type LoadOptions = Parameters<PanoViewer['load']>[1];
type PanoViewer = ReturnType<ViewerFactory>;
type View = ReturnType<PanoViewer['getView']>;

const CDN = 'https://cdn.test/';
const config = loadConfig({
  VITE_SITE_ORIGIN: 'https://panote.test',
  VITE_CDN_BASE: CDN,
  VITE_AUTH0_DOMAIN: 'tenant.auth0.com',
  VITE_AUTH0_CLIENT_ID: 'YOUR_CLIENT',
  VITE_AUTH0_AUDIENCE: 'https://api.test',
});

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

const scene = (panoId: string, title: string, hotspots: unknown[] = []) => ({
  panoId,
  config: { panoId, title, hotspots },
});
const bundle = (over: Record<string, unknown> = {}) => ({
  v: 1,
  tourId: 'tour-a',
  title: 'Old town',
  visibility: 'public',
  slug: 'old-town',
  publishedAt: '2026-09-20T00:00:00Z',
  settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
  startPanoId: 'square',
  scenes: [
    scene('square', 'Square', [
      { id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Fountain', body: '**Old**' },
      {
        id: 'l1',
        type: 'link',
        yaw: 1,
        pitch: -0.4,
        title: 'To the church',
        targetPanoId: 'church',
      },
    ]),
    scene('church', 'Church'),
  ],
  ...over,
});
const live = { v: 1, kind: 'tour', tourId: 'tour-a' };

class FakeViewer implements PanoViewer {
  failLoad = false;
  constructor(readonly options: ViewerOptions) {}
  load = vi.fn(async (pano: string, opts?: LoadOptions): Promise<boolean> => {
    if (opts?.transition) return this.crossfade(pano, opts.view);
    if (this.failLoad) throw new Error('manifest 404');
    this.emit('scene-change', { id: pano, kind: 'tiles' });
    return true;
  });
  /** A load with a transition: `load` hands those here, so a test can script hops apart. */
  crossfade = vi.fn(async (pano: string, _view?: unknown): Promise<boolean> => {
    this.emit('scene-change', { id: pano, kind: 'tiles' });
    return true;
  });
  setView = vi.fn();
  /** The camera getView() reports; a test moves it, then draws a frame. */
  view = { yaw: 0, pitch: 0, fov: 70 };
  getView = () => this.view;
  isSettled = () => false;
  focus = vi.fn();
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  setLabel = vi.fn();
  dispose = vi.fn();
  renders = new Set<(view: Readonly<View>) => void>();
  onRender = (cb: (view: Readonly<View>) => void) => {
    this.renders.add(cb);
    return () => {
      this.renders.delete(cb);
    };
  };
  /** Draws a frame; the camera counts as at rest a moment after the last one. */
  draw = () => act(() => this.renders.forEach((cb) => cb(this.view)));
  project = () => ({ x: 0, y: 0, behind: false });
  heading = () => 0;
  prefetch = vi.fn(async () => {});
  cancelLoad = vi.fn();
  showPreview = vi.fn();
  zoomBy = vi.fn();
  directionAtPixel = () => ({ yaw: 0, pitch: 0 });
  requestRender = vi.fn();
  readonly handlers = new Map<string, Set<(payload: never) => void>>();
  on<K extends keyof PanoViewerEvents>(
    type: K,
    fn: (payload: PanoViewerEvents[K]) => void,
  ): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
    return () => this.off(type, fn);
  }
  off<K extends keyof PanoViewerEvents>(type: K, fn: (payload: PanoViewerEvents[K]) => void): void {
    this.handlers.get(type)?.delete(fn);
  }
  emit<K extends keyof PanoViewerEvents>(type: K, payload?: PanoViewerEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as (p: typeof payload) => void)(payload));
  }
}

let viewers: FakeViewer[];
let failLoads: boolean;
let throwOnCreate: boolean;
const createViewer: ViewerFactory = (_el, options) => {
  if (throwOnCreate) throw new Error('viewer blew up');
  const v = new FakeViewer(options);
  v.failLoad = failLoads;
  viewers.push(v);
  return v;
};
const lastViewer = () => viewers[viewers.length - 1]!;

let objects: Record<string, unknown>;
// When set, the view POST's body is held until the test resolves it.
let viewGate: { promise: Promise<void>; resolve: () => void } | null;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
// What `GET /api/admin/tours/tour-a` answers: a status, a thrown network error, or
// an SPA fallback's HTML page with a 200.
let adminTour: number | 'error' | 'html';
const ownerBody = {
  tour: { tourId: 'tour-a', title: 'Old town', scenes: [{ panoId: 'square' }] },
  etag: 'e1',
  publish: null,
};
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/api/admin/')) {
    if (adminTour === 'error') throw new TypeError('network down');
    if (adminTour === 'html') {
      return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (adminTour === 200) return Response.json(ownerBody);
    const error = adminTour === 404 ? 'not found' : 'forbidden';
    return Response.json({ error }, { status: adminTour });
  }
  if (url.startsWith(CDN)) {
    const key = url.slice(CDN.length);
    return key in objects ? Response.json(objects[key]) : new Response('', { status: 404 });
  }
  if (url.startsWith('/api/tours/tour-a/')) {
    const liked = url.endsWith('/like');
    const gate = url.endsWith('/view') ? viewGate : null;
    if (gate) {
      const body = JSON.stringify({ views: 2400, likes: 7 });
      return { ok: true, status: 200, text: () => gate.promise.then(() => body) } as Response;
    }
    return Response.json(
      { views: 2400, likes: liked ? 8 : 7 },
      { status: init?.method ? 200 : 200 },
    );
  }
  return new Response('', { status: 500 });
});
const calls = (suffix: string) => fetchMock.mock.calls.filter(([u]) => String(u).endsWith(suffix));

// Signed out unless a test passes `signedIn()`.
function renderAt(path: string, auth: Auth = fakeAuth()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <StrictMode>
      <ConfigContext value={config}>
        <AuthEnvContext value={{ auth, origins: LOCAL }}>
          <StageFactoryContext value={createViewer}>
            <RouterProvider router={router} />
          </StageFactoryContext>
        </AuthEnvContext>
      </ConfigContext>
    </StrictMode>,
  );
  return router;
}

const signedIn = () =>
  fakeAuth({
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => ({ sub: 'google-oauth2|1', name: 'Ada' })),
  });
const adminCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/admin/'));

const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute('content');
const shown = (panoId: string) =>
  waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith(panoId, { view: undefined }));
const unavailable = () => screen.findByRole('heading', { name: "This tour isn't available" });
// The stats hook and the beacon's listeners only mount in the commit after the first
// scene-change, so `shown()` alone doesn't mean they exist yet. The view POST does.
const viewRecorded = () => waitFor(() => expect(calls('/api/tours/tour-a/view')).toHaveLength(1));

beforeEach(() => {
  viewers = [];
  failLoads = false;
  throwOnCreate = false;
  objects = { 'slugs/old-town.json': live, 'pub/tours/tour-a.json': bundle() };
  viewGate = null;
  adminTour = 200;
  localStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('tour languages', () => {
  const multilingual = () =>
    bundle({
      languages: { default: 'en', others: ['de', 'fr'] },
      i18n: { de: { title: 'Altstadt' } },
      scenes: [
        {
          panoId: 'square',
          config: {
            panoId: 'square',
            title: 'Square',
            i18n: { de: { title: 'Platz' } },
            hotspots: [
              {
                id: 'i1',
                type: 'info',
                yaw: 0.2,
                pitch: 0.1,
                title: 'Fountain',
                body: '**Old**',
                i18n: { de: { title: 'Brunnen' } },
              },
            ],
          },
        },
      ],
    });
  const navLanguages = (langs: string[]) =>
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(langs);

  beforeEach(() => {
    objects['pub/tours/tour-a.json'] = multilingual();
    // As index.html ships it.
    document.documentElement.setAttribute('lang', 'en');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.setAttribute('lang', 'en');
  });

  it('shows the language ?lang= asks for, falling back per field to the default', async () => {
    navLanguages(['fr']);
    renderAt('/s/old-town?lang=de');
    expect(await screen.findByText('Altstadt')).toBeTruthy();
    expect(screen.getByText('Platz').getAttribute('aria-current')).toBe('location');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Brunnen' }));
    // No German body: the English one shows.
    const panel = screen.getByRole('complementary', { name: 'Brunnen' });
    expect(panel.querySelector('strong')?.textContent).toBe('Old');
    expect(document.title).toBe('Altstadt · panote');
    expect(document.documentElement.getAttribute('lang')).toBe('de');
    expect(document.querySelector('.pn-tour')?.getAttribute('lang')).toBe('de');
  });

  it("else follows the browser's languages, by primary subtag too", async () => {
    navLanguages(['de-AT', 'en']);
    renderAt('/s/old-town');
    expect(await screen.findByText('Altstadt')).toBeTruthy();
  });

  it('else the default, and the picker switches language in place, keeping ?pano=', async () => {
    navLanguages(['ja']);
    const router = renderAt('/s/old-town?pano=square');
    expect(await screen.findByText('Old town')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement;
    expect(picker.value).toBe('en');
    const before = viewers.length;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      'English',
      'Deutsch',
      'Français',
    ]);
    fireEvent.change(picker, { target: { value: 'de' } });
    expect(await screen.findByText('Altstadt')).toBeTruthy();
    expect(router.state.location.search).toBe('?pano=square&lang=de');
    // Same scene, no new viewer and no load: only the text changed.
    expect(viewers).toHaveLength(before);
    expect(lastViewer().crossfade).not.toHaveBeenCalled();
  });

  it('the embed honours ?lang= and offers the picker over the stage', async () => {
    navLanguages(['en']);
    renderAt('/s/old-town/embed?lang=de');
    await shown('square');
    expect(document.title).toBe('Altstadt · panote');
    expect(screen.getByRole('button', { name: 'Brunnen' })).toBeTruthy();
    expect(
      screen.getByRole('combobox', { name: 'Language' }).closest('.pn-tour__lang'),
    ).toBeTruthy();
  });

  it('a tour in one language has no picker and leaves <html lang> alone', async () => {
    objects['pub/tours/tour-a.json'] = bundle();
    renderAt('/s/old-town?lang=de');
    await shown('square');
    expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
    expect(screen.getByText('Old town')).toBeTruthy();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});

describe('/s/:slug', () => {
  it('keeps every wheel for zooming on the full-page tour', async () => {
    renderAt('/s/old-town');
    await shown('square');
    expect(lastViewer().options.interaction?.wheel).toBe('always');
  });

  it('loads the slug, then the pub bundle, then the start scene from the CDN tiles', async () => {
    renderAt('/s/old-town');
    expect(await screen.findByText('Old town')).toBeTruthy();
    expect(screen.getByText('Square').getAttribute('aria-current')).toBe('location');
    // StrictMode mounts twice in tests, so the chain may run twice; order is what matters.
    const cdnReads = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(CDN));
    expect([...new Set(cdnReads)]).toEqual([
      `${CDN}slugs/old-town.json`,
      `${CDN}pub/tours/tour-a.json`,
    ]);
    await shown('square');
    // The stage resolves scenes against the CDN's tiles.
    await expect(
      lastViewer().options.resolveSource!('square', new AbortController().signal),
    ).rejects.toThrow('manifest 404');
    expect(fetchMock).toHaveBeenCalledWith(`${CDN}tiles/square/manifest.json`, expect.anything());
    expect(document.title).toBe('Old town · panote');
    expect(robots()).toBeUndefined();
  });

  it('shows a busy loading state until the tour arrives', async () => {
    renderAt('/s/old-town');
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading tour…');
    expect(status.closest('[aria-busy="true"]')).toBeTruthy();
    await shown('square');
    expect(screen.queryByText('Loading tour…')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows the tour's and the scene's descriptions under About, in the visitor's language", async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      description: 'A walk round the old town.',
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { description: 'Ein Rundgang.' } },
      scenes: [
        {
          panoId: 'square',
          config: {
            panoId: 'square',
            title: 'Square',
            description: 'Market days:\nTue and Sat',
            hotspots: [],
            i18n: { de: { description: 'Markttage' } },
          },
        },
      ],
    });
    renderAt('/s/old-town?lang=de');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'About this tour' }));
    const about = screen.getByRole('complementary', { name: 'About this tour' });
    expect(within(about).getByText('Ein Rundgang.')).toBeTruthy();
    expect(within(about).getByText('Markttage')).toBeTruthy();
  });

  it('shows info points, their panel, and walks a link to the next scene', async () => {
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    const panel = screen.getByRole('complementary', { name: 'Fountain' });
    expect(panel.querySelector('strong')?.textContent).toBe('Old');
    // Clicking the open point's marker again closes it (see 'analytics beacon' for the count).
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    expect(screen.queryByRole('complementary', { name: 'Fountain' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(lastViewer().crossfade).toHaveBeenCalledWith('church', { yaw: 1 }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByText('Church').getAttribute('aria-current')).toBe('location');
  });

  it('shows linked media inline from any https host', async () => {
    const point = (id: string, yaw: number, title: string, media: object) => ({
      id,
      type: 'info',
      yaw,
      pitch: 0,
      title,
      media,
    });
    objects['pub/tours/tour-a.json'] = bundle({
      scenes: [
        scene('square', 'Square', [
          point('m1', 0, 'Plan', { kind: 'image', url: `${CDN}media/plan.jpg` }),
          point('m2', 0.5, 'Clip', { kind: 'video', url: 'https://other.test/clip.mp4' }),
          point('m3', 1, 'Bells', { kind: 'audio', url: 'https://sounds.test/bells.mp3' }),
          point('m4', 1.5, 'Film', { kind: 'vimeo', id: '76979871' }),
          point('m5', 2, 'History', { kind: 'link', url: 'https://example.org/history' }),
        ]),
      ],
    });
    renderAt('/s/old-town');
    await shown('square');
    const panel = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name }));
      return screen.getByRole('complementary');
    };
    expect(panel('Plan').querySelector('img')?.getAttribute('src')).toBe(`${CDN}media/plan.jpg`);
    expect(panel('Clip').querySelector('video')?.getAttribute('src')).toBe(
      'https://other.test/clip.mp4',
    );
    expect(panel('Bells').querySelector('audio')?.getAttribute('src')).toBe(
      'https://sounds.test/bells.mp3',
    );
    expect(panel('Film').querySelector('iframe')?.getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871?dnt=1',
    );
    panel('History');
    expect(screen.getByRole('link', { name: 'Visit example.org ↗' }).getAttribute('href')).toBe(
      'https://example.org/history',
    );
  });

  it('names a link media without URL.canParse (Safari 16)', async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      scenes: [
        scene('square', 'Square', [
          {
            id: 'm1',
            type: 'info',
            yaw: 0,
            pitch: 0,
            title: 'History',
            media: { kind: 'link', url: 'https://example.org/history' },
          },
        ]),
      ],
    });
    // jsdom's URL inherits canParse from Node's, so delete it where it is defined.
    let owner: object | null = URL;
    while (owner && !Object.hasOwn(owner, 'canParse')) owner = Object.getPrototypeOf(owner);
    const canParse = owner && Object.getOwnPropertyDescriptor(owner, 'canParse');
    if (owner) Reflect.deleteProperty(owner, 'canParse');
    expect('canParse' in URL).toBe(false);
    try {
      renderAt('/s/old-town');
      await shown('square');
      fireEvent.click(screen.getByRole('button', { name: 'History' }));
      expect(screen.getByRole('link', { name: 'Visit example.org ↗' })).toBeTruthy();
    } finally {
      if (owner && canParse) Object.defineProperty(owner, 'canParse', canParse);
    }
  });

  it('honours the tour settings', async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      settings: { controls: 'top', showMap: false, showCompass: false, autoRotate: true },
    });
    renderAt('/s/old-town');
    // The viewer is created in PanoStage's effect, which can land after the title renders.
    await shown('square');
    expect(screen.getByRole('toolbar').className).toContain('pn-controls--top');
    expect(screen.queryByRole('img', { name: 'Compass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    expect(lastViewer().options.autoRotate).toMatchObject({ enabled: true });
  });

  it('shows the compass and scene map by default', async () => {
    renderAt('/s/old-town');
    await screen.findByText('Old town');
    expect(screen.getByRole('img', { name: 'Compass' })).toBeTruthy();
    // Picking a scene before the first load lands would cut to it instead of crossfading.
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Church' }));
    await waitFor(() => expect(lastViewer().crossfade).toHaveBeenCalledWith('church', undefined));
  });

  it('draws the floor plan from the bundle, with dots that go to their scene', async () => {
    const base = bundle();
    objects['pub/tours/tour-a.json'] = bundle({
      plan: { id: 'plan-1', type: 'image/webp', width: 800, height: 600 },
      scenes: (base.scenes as Array<Record<string, unknown>>).map((s, i) => ({
        ...s,
        mapX: i === 0 ? 0.25 : 0.75,
        mapY: 0.5,
      })),
    });
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const plan = screen.getByRole('group', { name: 'Floor plan' });
    expect(plan.querySelector('img')?.getAttribute('src')).toBe(
      `${CDN}pub/plans/tour-a/plan-1.webp`,
    );
    fireEvent.click(within(plan).getByRole('button', { name: 'Church' }));
    await waitFor(() => expect(lastViewer().crossfade).toHaveBeenCalledWith('church', undefined));
  });

  it('adds noindex for an unlisted tour', async () => {
    objects['pub/tours/tour-a.json'] = bundle({ visibility: 'unlisted' });
    renderAt('/s/old-town');
    await screen.findByText('Old town');
    expect(robots()).toBe('noindex');
  });

  it("adds noindex while a new account's tour is held back", async () => {
    const heldUntil = new Date(Date.now() + 60_000).toISOString();
    objects['pub/tours/tour-a.json'] = bundle({ heldUntil });
    renderAt('/s/old-town');
    await screen.findByText('Old town');
    expect(robots()).toBe('noindex');
  });

  it('records one view and shows the counts', async () => {
    renderAt('/s/old-town');
    expect(await screen.findByText('2.4k')).toBeTruthy();
    expect(calls('/api/tours/tour-a/view')).toHaveLength(1);
    expect(calls('/api/tours/tour-a/view')[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ panoId: 'square', surface: 'page' }),
    });
  });

  it('likes with a stable X-Client-Id and only once', async () => {
    renderAt('/s/old-town');
    // The button renders before the stats hook's view effect runs. Click first and the
    // view is sent after the like, so its counts (the mock's likes 7) count as newer and
    // win. Wait for the view to be sent, not answered, so the like still races it.
    await viewRecorded();
    fireEvent.click(screen.getByRole('button', { name: 'Like this tour' }));
    await screen.findByRole('button', { name: 'Liked' });
    await waitFor(() => expect(calls('/api/tours/tour-a/like')).toHaveLength(1));
    const [call] = calls('/api/tours/tour-a/like');
    const id = localStorage.getItem('panote_client_id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.[1]).toMatchObject({ method: 'POST', headers: { 'X-Client-Id': id } });
    fireEvent.click(screen.getByRole('button', { name: 'Liked' }));
    expect(calls('/api/tours/tour-a/like')).toHaveLength(1);
    expect(await screen.findByText('8')).toBeTruthy();
  });

  it('keeps the like count when the view response lands after the like', async () => {
    viewGate = deferred();
    renderAt('/s/old-town');
    await viewRecorded();
    fireEvent.click(screen.getByRole('button', { name: 'Like this tour' }));
    expect(await screen.findByText('8')).toBeTruthy();
    // Release the view response (likes 7) and let its whole promise chain settle.
    await act(async () => {
      viewGate?.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.queryByText('7')).toBeNull();
  });

  it('starts at ?pano= on the full viewer, keeping navigation', async () => {
    renderAt('/s/old-town?pano=church');
    await shown('church');
    expect(screen.getByRole('button', { name: 'Map' })).toBeTruthy();
  });
});

describe('tour data inlined by the Worker', () => {
  const inline = (data: unknown) => {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'pn-boot';
    el.textContent = JSON.stringify(data);
    document.head.append(el);
  };
  const cdnReads = () =>
    fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(CDN));
  afterEach(() => document.getElementById('pn-boot')?.remove());

  it('shows the tour without reading the slug or the bundle', async () => {
    inline({ slug: 'old-town', record: live, tour: bundle({ title: 'Inlined town' }) });
    renderAt('/s/old-town');
    expect(await screen.findByText('Inlined town')).toBeTruthy();
    await shown('square');
    expect(cdnReads()).toEqual([]);
  });

  // What the visitor waits on before the first tile request: React commits and
  // scheduler tasks (each one a chance for the browser to paint a frame first).
  it('asks the viewer for the start scene within two commits of the first render', async () => {
    inline({ slug: 'old-town', record: live, tour: bundle() });
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const actEnv = env.IS_REACT_ACT_ENVIRONMENT;
    // Rendered outside act(), which would flush every effect up front, so the
    // count is the real one.
    env.IS_REACT_ACT_ENVIRONMENT = false;
    let commits = 0;
    let atLoad: { commits: number; tasks: number } | null = null;
    let tasks = 0;
    const measured: ViewerFactory = (el, options) => {
      const v = createViewer(el, options) as unknown as FakeViewer;
      const load = v.load.getMockImplementation()!;
      v.load.mockImplementation((pano, opts) => {
        atLoad ??= { commits, tasks };
        return load(pano, opts);
      });
      return v;
    };
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    try {
      root.render(
        <StrictMode>
          <Profiler id="tour" onRender={() => commits++}>
            <ConfigContext value={config}>
              <AuthEnvContext value={{ auth: fakeAuth(), origins: LOCAL }}>
                <StageFactoryContext value={measured}>
                  <RouterProvider
                    router={createMemoryRouter(routes, { initialEntries: ['/s/old-town'] })}
                  />
                </StageFactoryContext>
              </AuthEnvContext>
            </ConfigContext>
          </Profiler>
        </StrictMode>,
      );
      while (!atLoad && tasks < 50) {
        await new Promise((r) => setImmediate(r));
        tasks++;
      }
      expect(atLoad).not.toBeNull();
      expect(atLoad!.commits).toBeLessThanOrEqual(2);
      // The load starts in the task that commits the tour, with no frame between.
      expect(atLoad!.tasks).toBeLessThanOrEqual(1);
      // Exactly one load, on the one viewer left standing after StrictMode's remount.
      expect(viewers.filter((v) => v.load.mock.calls.length > 0)).toHaveLength(1);
      expect(viewers.filter((v) => v.dispose.mock.calls.length === 0)).toHaveLength(1);
    } finally {
      root.unmount();
      host.remove();
      env.IS_REACT_ACT_ENVIRONMENT = actEnv;
    }
  });

  it('fetches as usual when the inlined data is for another slug', async () => {
    inline({ slug: 'elsewhere', record: live, tour: bundle({ title: 'Inlined town' }) });
    renderAt('/s/old-town');
    expect(await screen.findByText('Old town')).toBeTruthy();
    expect(new Set(cdnReads())).toEqual(
      new Set([`${CDN}slugs/old-town.json`, `${CDN}pub/tours/tour-a.json`]),
    );
  });

  it('never uses inlined data on a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    objects['slugs/old-town.json'] = { v: 9 };
    renderAt('/s/old-town');
    await screen.findByRole('heading', { name: "This tour couldn't be loaded" });
    // Valid data for this slug is on the page now, but a retry must go to the network.
    inline({ slug: 'old-town', record: live, tour: bundle({ title: 'Inlined town' }) });
    objects['slugs/old-town.json'] = live;
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Old town')).toBeTruthy();
    expect(screen.queryByText('Inlined town')).toBeNull();
    expect(cdnReads()).toContain(`${CDN}slugs/old-town.json`);
  });

  it('ignores unparseable inlined data', async () => {
    inline('x');
    document.getElementById('pn-boot')!.textContent = '{not json';
    renderAt('/s/old-town');
    expect(await screen.findByText('Old town')).toBeTruthy();
  });
});

describe('unavailable placeholder', () => {
  it('shows for a missing slug', async () => {
    objects = {};
    renderAt('/s/old-town');
    await unavailable();
    expect(robots()).toBe('noindex');
    expect(calls('/view')).toHaveLength(0);
  });

  it('shows for a missing pub bundle', async () => {
    delete objects['pub/tours/tour-a.json'];
    renderAt('/s/old-town');
    await unavailable();
  });

  it('shows when the start scene fails to load (manifest 404)', async () => {
    failLoads = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderAt('/s/old-town');
    await unavailable();
    // The stats hook only mounts once a scene is on screen.
    expect(calls('/view')).toHaveLength(0);
  });

  it('shows for an invalid slug without fetching', async () => {
    renderAt('/s/Not..Valid');
    await unavailable();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers a retry on a non-404 failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    objects['slugs/old-town.json'] = { v: 9 };
    renderAt('/s/old-town');
    await screen.findByRole('heading', { name: "This tour couldn't be loaded" });
    objects['slugs/old-town.json'] = live;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Old town')).toBeTruthy();
  });
});

describe('route error boundary', () => {
  it.each(['/s/old-town', '/s/old-town/embed'])(
    'shows the retry placeholder when %s throws while rendering',
    async (path) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      throwOnCreate = true;
      renderAt(path);
      expect(
        await screen.findByRole('heading', { name: "This tour couldn't be loaded" }),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    },
  );
});

describe('slug aliases fetched by the SPA (no Worker)', () => {
  it('follows an alias to the same tour, keeping embed and ?pano=', async () => {
    objects['slugs/old-name.json'] = {
      v: 1,
      kind: 'redirect',
      tourId: 'tour-a',
      redirect: 'old-town',
      expiresAt: FUTURE,
    };
    const router = renderAt('/s/old-name/embed?pano=church');
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/s/old-town/embed?pano=church',
      ),
    );
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('church', { view: undefined }),
    );
  });

  it('never follows an alias onto another tour', async () => {
    objects['slugs/old-name.json'] = {
      v: 1,
      kind: 'redirect',
      tourId: 'tour-z',
      redirect: 'old-town',
      expiresAt: FUTURE,
    };
    const router = renderAt('/s/old-name');
    await unavailable();
    expect(router.state.location.pathname).toBe('/s/old-name');
  });
});

describe('the scene and view in the URL', () => {
  const SETTLED = { timeout: 2000 };
  const deg = Math.PI / 180;
  /**
   * Draws a frame and runs the clock past the viewer's settle wait (on fake timers, so no
   * real wait), then lets the router's navigation, if any, finish.
   */
  const rest = async () => {
    vi.useFakeTimers();
    try {
      lastViewer().draw();
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => {});
  };
  const settle = async (router: ReturnType<typeof renderAt>, search: string) => {
    lastViewer().draw();
    await waitFor(() => expect(router.state.location.search).toBe(search), SETTLED);
  };

  it('pushes an entry per scene, so Back and Forward step through scenes', async () => {
    const router = renderAt('/s/old-town');
    await shown('square');
    expect(router.state.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(router.state.location.search).toBe('?pano=church'));
    expect(router.state.historyAction).toBe('PUSH');
    const viewer = lastViewer();

    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('');
    await waitFor(() => expect(viewer.crossfade).toHaveBeenLastCalledWith('square', undefined));
    expect(screen.getByText('Square').getAttribute('aria-current')).toBe('location');
    // Landing back on it is not a new entry.
    expect(router.state.historyAction).toBe('POP');

    await act(() => router.navigate(1));
    await waitFor(() => expect(viewer.crossfade).toHaveBeenLastCalledWith('church', undefined));
    expect(router.state.location.search).toBe('?pano=church');
    expect(router.state.historyAction).toBe('POP');
    // Still the one viewer: Back moved within the tour, it didn't reload it.
    expect(lastViewer()).toBe(viewer);
  });

  it('replaces the entry with the camera once it comes to rest, in whole degrees', async () => {
    const router = renderAt('/s/old-town?lang=en');
    await shown('square');
    // Where the scene opened: nothing to write.
    await rest();
    expect(router.state.location.search).toBe('?lang=en');
    lastViewer().view = { yaw: 12.4 * deg, pitch: -5.2 * deg, fov: 59.6 };
    await settle(router, '?lang=en&pano=square&yaw=12&pitch=-5&fov=60');
    expect(router.state.historyAction).toBe('REPLACE');
    // Past ±180 the yaw wraps.
    lastViewer().view = { yaw: 190 * deg, pitch: 0, fov: 60 };
    await settle(router, '?lang=en&pano=square&yaw=-170&pitch=0&fov=60');
  });

  it('opens a shared view', async () => {
    renderAt('/s/old-town?pano=church&yaw=90&pitch=10&fov=50');
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalled());
    const [pano, opts] = lastViewer().load.mock.calls[0]!;
    expect(pano).toBe('church');
    expect(opts?.view?.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(opts?.view?.pitch).toBeCloseTo(10 * deg, 6);
    expect(opts?.view?.fov).toBe(50);
  });

  it('ignores camera values out of range', async () => {
    renderAt('/s/old-town?pano=church&yaw=x&pitch=95&fov=500');
    await shown('church');
  });

  it("leaves the URL alone in an embed, whose entries would join the host page's history", async () => {
    const router = renderAt('/s/old-town/embed');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(lastViewer().crossfade).toHaveBeenCalledWith('church', { yaw: 1 }));
    lastViewer().view = { yaw: 1, pitch: 0.1, fov: 60 };
    await rest();
    expect(router.state.location.search).toBe('');
    expect(router.state.historyAction).toBe('POP');
  });
});

describe('fullscreen without the Fullscreen API (iPhone)', () => {
  beforeEach(() =>
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false }),
  );
  afterEach(() => Reflect.deleteProperty(document, 'fullscreenEnabled'));

  it('pins the tour over the page, hiding its bar', async () => {
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(document.querySelector('.pn-tour')?.classList.contains('pn-pseudo-fullscreen')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(document.querySelector('.pn-pseudo-fullscreen')).toBeNull();
  });

  it('opens the tour page in a new tab from an embed, at the scene on screen', async () => {
    renderAt('/s/old-town/embed?lang=en');
    await shown('square');
    const link = screen.getByRole('link', { name: 'Open fullscreen in a new tab' });
    expect(link.getAttribute('href')).toBe('/s/old-town?lang=en&pano=square');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('offers no way out of an embed pinned to one scene', async () => {
    renderAt('/s/old-town/embed?pano=square');
    await shown('square');
    expect(screen.queryByRole('link', { name: 'Open fullscreen in a new tab' })).toBeNull();
  });
});

describe('/s/:slug/embed', () => {
  it('lets a plain wheel scroll the host page until the viewer is engaged', async () => {
    renderAt('/s/old-town/embed');
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
    );
    expect(lastViewer().options.interaction?.wheel).toBe('engaged');
  });

  it('has no site chrome and keeps whole-tour navigation', async () => {
    renderAt('/s/old-town/embed');
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
    );
    await viewRecorded();
    expect(screen.queryByRole('navigation', { name: 'Tour' })).toBeNull();
    expect(document.querySelector('.app-shell__bar')).toBeNull();
    // Checked once the (hidden) stats hook has mounted, so this isn't vacuous.
    expect(screen.queryByRole('button', { name: 'Like this tour' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Go to To the church' })).toBeTruthy();
    expect(calls('/api/tours/tour-a/view')[0]?.[1]?.body).toBe(
      JSON.stringify({ panoId: 'square', surface: 'embed' }),
    );
  });

  it('says so when the graphics memory runs out, rather than going black', async () => {
    renderAt('/s/old-town/embed');
    await shown('square');
    act(() => lastViewer().emit('context-lost'));
    expect(screen.getByRole('alert').textContent).toContain(
      'The viewer ran out of graphics memory.',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('limits ?pano= to one scene with no nav links', async () => {
    renderAt('/s/old-town/embed?pano=square');
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
    );
    expect(screen.getByRole('button', { name: 'Fountain' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Go to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the placeholder for an unknown ?pano= or a missing tour', async () => {
    renderAt('/s/old-town/embed?pano=gone');
    await unavailable();
    expect(calls('/view')).toHaveLength(0);
    cleanup();
    objects = {};
    renderAt('/s/old-town/embed/');
    await unavailable();
  });

  it('is noindex when unlisted', async () => {
    objects['pub/tours/tour-a.json'] = bundle({ visibility: 'unlisted' });
    renderAt('/s/old-town/embed');
    // The loading state is noindex too, so wait for the tour itself first.
    await shown('square');
    expect(robots()).toBe('noindex');
  });
});

describe('visitor share', () => {
  // How Chrome words a lazy chunk that 404s after a deploy.
  const staleChunk = () =>
    new TypeError('Failed to fetch dynamically imported module: https://panote.test/assets/x.js');
  let load: MockInstance<typeof shareChunk.load>;
  let reload: MockInstance<typeof page.reload>;
  // The sheet is a lazy chunk: transform it once up front so the first test's query
  // doesn't time out on it, and give the lazy render more than the default 1s on a
  // loaded CI runner (as the lazy page tests do).
  beforeAll(async () => {
    await import('@internal/ui/share');
  });
  const LAZY = { timeout: 5000 };
  beforeEach(() => {
    shareChunk.pending = null;
    load = vi.spyOn(shareChunk, 'load');
    reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    shareChunk.pending = null;
  });
  // The same viewer, never torn down: the tour did not unmount or remount.
  const tourStillUp = (viewer: FakeViewer) => {
    expect(lastViewer()).toBe(viewer);
    expect(viewer.dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('toolbar', { name: 'View' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
  };

  it('shares the tour by default, or this view: the scene and camera at rest', async () => {
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(lastViewer().crossfade).toHaveBeenCalledWith('church', { yaw: 1 }));
    lastViewer().view = { yaw: Math.PI / 4, pitch: 0, fov: 65 };
    // The camera comes to rest a moment after the last frame (on fake timers: no real wait).
    vi.useFakeTimers();
    try {
      lastViewer().draw();
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY);
    const link = within(dialog).getByLabelText('Share link');
    expect(link.textContent).toBe('panote.test/s/old-town');
    fireEvent.click(within(dialog).getByRole('radio', { name: /This view.*Church/ }));
    expect(link.textContent).toBe('panote.test/s/old-town?pano=church&yaw=45&pitch=0&fov=65');
  });

  it('loads the sheet on demand, warming it up when the visitor reaches for Share', async () => {
    renderAt('/s/old-town');
    await shown('square');
    expect(load).not.toHaveBeenCalled();
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Share' }));
    expect(load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY)).toBeTruthy();
    // The warm-up's import is the one the sheet renders from.
    expect(load).toHaveBeenCalledOnce();
  });

  it('shows Share busy from the press until the sheet arrives', async () => {
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    load.mockImplementation(async () => {
      await arrived;
      return import('@internal/ui/share');
    });
    try {
      renderAt('/s/old-town');
      await shown('square');
      const share = screen.getByRole('button', { name: 'Share' });
      // Warming it up is not a press: nothing to show yet.
      fireEvent.pointerEnter(share);
      expect(share.getAttribute('aria-busy')).toBeNull();
      fireEvent.click(share);
      await waitFor(() => expect(share.getAttribute('aria-busy')).toBe('true'));
      expect(share.querySelector('.pn-btn__spinner')).toBeTruthy();
      arrive();
      expect(await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY)).toBeTruthy();
      expect(share.getAttribute('aria-busy')).toBeNull();
    } finally {
      // An import left in flight would keep the page from reloading in later tests.
      arrive();
      await arrived;
    }
  });

  it('shows the plain link while a hanging chunk keeps the sheet waiting, then tries again', async () => {
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    load.mockImplementation(async () => {
      await arrived;
      return import('@internal/ui/share');
    });
    const stallMs = shareChunk.stallMs;
    shareChunk.stallMs = 20;
    try {
      renderAt('/s/old-town');
      await shown('square');
      const viewer = lastViewer();
      const share = screen.getByRole('button', { name: 'Share' });
      fireEvent.click(share);
      const fallback = await screen.findByRole('alert', {}, LAZY);
      expect(within(fallback).getByRole('button', { name: 'Copy link' })).toBeTruthy();
      expect(share.getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      tourStillUp(viewer);
      fireEvent.click(within(fallback).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('alert')).toBeNull();
      // The chunk turns up after all: the next Share opens the sheet.
      shareChunk.stallMs = stallMs;
      arrive();
      fireEvent.click(share);
      expect(await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY)).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(load).toHaveBeenCalledOnce();
    } finally {
      shareChunk.stallMs = stallMs;
      arrive();
      await arrived;
    }
  });

  it('drops the stall timer once the sheet arrives in time', async () => {
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    load.mockImplementation(async () => {
      await arrived;
      return import('@internal/ui/share');
    });
    const stallMs = shareChunk.stallMs;
    // Long enough that the preloaded chunk always beats it, short enough to wait out.
    shareChunk.stallMs = 400;
    try {
      renderAt('/s/old-town');
      await shown('square');
      const share = screen.getByRole('button', { name: 'Share' });
      fireEvent.click(share);
      // The timer is armed while the sheet waits.
      await waitFor(() => expect(share.getAttribute('aria-busy')).toBe('true'));
      arrive();
      expect(await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY)).toBeTruthy();
      await act(() => new Promise((r) => setTimeout(r, 600)));
      expect(screen.getByRole('dialog', { name: 'Share this tour' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      shareChunk.stallMs = stallMs;
      arrive();
      await arrived;
    }
  });

  it('retries a chunk that failed to load once, then opens the sheet', async () => {
    load.mockRejectedValueOnce(staleChunk());
    renderAt('/s/old-town');
    await shown('square');
    const viewer = lastViewer();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY)).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    tourStillUp(viewer);
    expect(reload).not.toHaveBeenCalled();
  });

  it('falls back to the plain link when the retry fails too, and keeps the tour up', async () => {
    load.mockRejectedValue(staleChunk());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderAt('/s/old-town');
    await shown('square');
    const viewer = lastViewer();
    // A failed warm-up is swallowed (no unhandled rejection) and forgotten, so the
    // click fetches again.
    fireEvent.focus(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(shareChunk.pending).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const fallback = await screen.findByRole('alert', {}, LAZY);
    expect(fallback.textContent).toContain("Couldn't open sharing");
    expect(within(fallback).getByRole('link').getAttribute('href')).toBe(
      'https://panote.test/s/old-town',
    );
    // The warm-up, the click's import, then the one retry.
    expect(load).toHaveBeenCalledTimes(3);
    tourStillUp(viewer);
    expect(screen.queryByRole('heading', { name: "This tour isn't available" })).toBeNull();
    // The share button never reloads the page, even for a stale chunk.
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(within(fallback).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('alert', {}, LAZY)).toBeTruthy();
    tourStillUp(viewer);
  });

  it('gives the fallback a copy button, focus and Escape', async () => {
    load.mockRejectedValue(staleChunk());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      renderAt('/s/old-town');
      await shown('square');
      const share = screen.getByRole('button', { name: 'Share' });
      share.focus();
      fireEvent.click(share);
      const fallback = await screen.findByRole('alert', {}, LAZY);
      // Focus moves in, to the copy button; the plain link stays too.
      const copy = within(fallback).getByRole('button', { name: 'Copy link' });
      expect(document.activeElement).toBe(copy);
      expect(within(fallback).getByRole('link').getAttribute('href')).toBe(
        'https://panote.test/s/old-town',
      );
      await act(async () => fireEvent.click(copy));
      expect(writeText).toHaveBeenCalledWith('https://panote.test/s/old-town');
      expect(within(fallback).getByRole('button', { name: 'Copied ✓' })).toBeTruthy();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.activeElement).toBe(share);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it("does not let Vite's preload-error reload the page for the share chunk", async () => {
    let event: Event | undefined;
    load.mockImplementation(async () => {
      // What Vite's preload helper does before it rejects.
      event = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(event);
      throw staleChunk();
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.clear();
    // main.tsx installs this for the whole site.
    const stop = reloadOnPreloadError();
    try {
      renderAt('/s/old-town');
      await shown('square');
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      expect(await screen.findByRole('alert', {}, LAZY)).toBeTruthy();
      expect(event?.defaultPrevented).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      // Any other chunk still reloads once.
      const other = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(other);
      expect(other.defaultPrevented).toBe(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      stop();
      sessionStorage.clear();
    }
  });

  it('opens the Link-only sheet with the canonical public URL', async () => {
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY);
    expect(within(dialog).getByRole('status', { name: 'Share link' }).textContent).toBe(
      'panote.test/s/old-town',
    );
    // Visitor variant: no Privacy/Embed tabs and no slug editing.
    expect(within(dialog).queryByRole('tab')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Edit custom link' })).toBeNull();
    const x = within(dialog).getByRole('link', { name: 'Share on X' });
    expect(x.getAttribute('href')).toContain(encodeURIComponent('https://panote.test/s/old-town'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Once loaded the sheet stays mounted: closed, it opens again.
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Share this tour' }, LAZY)).toBeTruthy();
  });

  it('is not offered in the embed', async () => {
    renderAt('/s/old-town/embed');
    await shown('square');
    await viewRecorded();
    expect(screen.getByRole('toolbar', { name: 'View' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });
});

describe('owner Edit', () => {
  const editLink = () => screen.findByRole('link', { name: 'Edit' });

  it('shows for the owner, linking to the admin editor', async () => {
    const auth = signedIn();
    renderAt('/s/old-town', auth);
    expect((await editLink()).getAttribute('href')).toBe(`${LOCAL.admin}/app/t/tour-a`);
    const [url, init] = adminCalls()[0] ?? [];
    expect(url).toBe('/api/admin/tours/tour-a');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer jwt-token' });
  });

  it('makes no admin call for an anonymous visitor', async () => {
    const auth = fakeAuth();
    renderAt('/s/old-town', auth);
    await shown('square');
    await viewRecorded();
    await waitFor(() => expect(auth.isAuthenticated).toHaveBeenCalled());
    // Let the signed-out account state settle before checking nothing followed it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(adminCalls()).toHaveLength(0);
    expect(auth.getAccessToken).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it.each([
    ['a signed-out token (401)', 401],
    ['a non-owner (403)', 403],
    ['a missing tour (404)', 404],
    ['a server error', 500],
    ['a network error', 'error'],
    ['an HTML page with a 200 (SPA fallback)', 'html'],
  ] as const)('stays hidden for %s', async (_label, status) => {
    adminTour = status;
    renderAt('/s/old-town', signedIn());
    await shown('square');
    await waitFor(() => expect(adminCalls().length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('stays hidden when the token cannot be had', async () => {
    const auth = signedIn();
    vi.mocked(auth.getAccessToken).mockRejectedValue(new Error('login_required'));
    renderAt('/s/old-town', auth);
    await shown('square');
    await waitFor(() => expect(auth.getAccessToken).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(adminCalls()).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('never checks ownership, or shows Edit, in the embed', async () => {
    const auth = signedIn();
    renderAt('/s/old-town/embed', auth);
    await shown('square');
    await viewRecorded();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(auth.isAuthenticated).not.toHaveBeenCalled();
    expect(adminCalls()).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });
});

describe('Report', () => {
  it('opens a mail to hello@panote.io with the tour link filled in', async () => {
    renderAt('/s/old-town');
    await shown('square');
    const link = screen.getByRole('link', { name: 'Report this tour' });
    const href = new URL(link.getAttribute('href')!);
    expect(href.protocol).toBe('mailto:');
    expect(href.pathname).toBe('hello@panote.io');
    expect(href.searchParams.get('subject')).toBe('Report a tour');
    expect(href.searchParams.get('body')).toContain('Tour: https://panote.test/s/old-town\r\n');
    expect(link.getAttribute('href')).toContain('%0D%0A');
    expect(link.textContent).toBe('Report');
  });

  it('shows for the owner too, beside Edit', async () => {
    renderAt('/s/old-town', signedIn());
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.getByRole('link', { name: 'Report this tour' })).toBeTruthy();
  });

  it('is not in the embed', async () => {
    renderAt('/s/old-town/embed');
    await shown('square');
    expect(screen.queryByRole('link', { name: 'Report this tour' })).toBeNull();
  });
});

// The real site auth over a fake SDK: `loadSdk` stands in for the lazy chunk import.
describe('owner Edit with the site auth', () => {
  const auth0 = { ...config.auth0, clientId: 'client-1', configured: true };
  const sdkClient: Auth0Like = {
    loginWithRedirect: vi.fn(async () => {}),
    handleRedirectCallback: vi.fn(async () => ({})),
    getTokenSilently: vi.fn(async () => 'jwt-token'),
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => ({ sub: 'google-oauth2|1', name: 'Ada' })),
    logout: vi.fn(async () => {}),
  };
  const loadSdk = vi.fn(async () => sdkClient);
  beforeEach(() => loadSdk.mockClear());

  it('never loads the SDK, or shows Edit, without a cached session', async () => {
    localStorage.setItem('unrelated', '1');
    renderAt('/s/old-town', createSiteAuth(auth0, LOCAL, loadSdk));
    await shown('square');
    await viewRecorded();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(loadSdk).not.toHaveBeenCalled();
    expect(adminCalls()).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('loads the SDK and shows Edit for the owner once the SDK cache has an entry', async () => {
    localStorage.setItem('@@auth0spajs@@::client-1::@@user@@', '{}');
    renderAt('/s/old-town', createSiteAuth(auth0, LOCAL, loadSdk));
    const edit = await screen.findByRole('link', { name: 'Edit' });
    expect(edit.getAttribute('href')).toBe(`${LOCAL.admin}/app/t/tour-a`);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(adminCalls()[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer jwt-token' });
  });

  it('treats unreadable storage as signed out', async () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    localStorage.setItem('@@auth0spajs@@::client-1::@@user@@', '{}');
    try {
      renderAt('/s/old-town', createSiteAuth(auth0, LOCAL, loadSdk));
      await shown('square');
      await viewRecorded();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(loadSdk).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('analytics beacon', () => {
  const beacons = () =>
    sendBeacon.mock.calls.flatMap(([url, body]) => {
      expect(url).toBe('/api/tours/tour-a/events');
      return (JSON.parse(String(body)) as { events: unknown[] }).events;
    });
  const sendBeacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
  beforeEach(() => {
    sendBeacon.mockClear();
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'sendBeacon');
  });

  it('sends scene, hotspot and dwell events when the page hides', async () => {
    renderAt('/s/old-town/embed');
    await shown('square');
    // The pagehide listener is attached in the same commit that records the view.
    await viewRecorded();
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    // A minute on the scene, without waiting one: dwell is timed with performance.now().
    const later = performance.now() + 60_000;
    vi.spyOn(performance, 'now').mockReturnValue(later);
    window.dispatchEvent(new Event('pagehide'));
    vi.mocked(performance.now).mockRestore();
    const events = beacons();
    expect(events).toContainEqual({ type: 'scene', panoId: 'square', surface: 'embed' });
    expect(events).toContainEqual({
      type: 'dwell',
      ms: expect.any(Number) as number,
      surface: 'embed',
    });
    const dwell = events.filter((e) => (e as { type: string }).type === 'dwell').at(-1);
    expect((dwell as { ms: number }).ms).toBeGreaterThanOrEqual(60_000);
    expect(events).toContainEqual({
      type: 'hotspot',
      panoId: 'square',
      hotspotId: 'i1',
      surface: 'embed',
    });
    expect(calls('/events')).toHaveLength(0);
  });

  it('counts a point opened and closed again once (Insights counted it twice)', async () => {
    renderAt('/s/old-town');
    await shown('square');
    await viewRecorded();
    const marker = screen.getByRole('button', { name: 'Fountain' });
    fireEvent.click(marker);
    fireEvent.click(marker);
    window.dispatchEvent(new Event('pagehide'));
    const opens = beacons().filter((e) => (e as { type: string }).type === 'hotspot');
    expect(opens).toEqual([
      { type: 'hotspot', panoId: 'square', hotspotId: 'i1', surface: 'page' },
    ]);
  });

  it('tags a point opened after a link with the scene it is on', async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      scenes: [
        bundle().scenes[0],
        scene('church', 'Church', [{ id: 'i2', type: 'info', yaw: 0.3, pitch: 0, title: 'Altar' }]),
      ],
    });
    renderAt('/s/old-town');
    await shown('square');
    await viewRecorded();
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(lastViewer().crossfade.mock.calls.at(-1)?.[0]).toBe('church'));
    fireEvent.click(await screen.findByRole('button', { name: 'Altar' }));
    window.dispatchEvent(new Event('pagehide'));
    expect(beacons()).toContainEqual({
      type: 'hotspot',
      panoId: 'church',
      hotspotId: 'i2',
      surface: 'page',
    });
  });

  it('sends nothing for a tour that never shows a scene', async () => {
    failLoads = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderAt('/s/old-town');
    await unavailable();
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

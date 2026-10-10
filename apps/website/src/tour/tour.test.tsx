import type { ViewerFactory } from '@internal/ui';
import { loadConfig, type Auth, type Auth0Like } from '@internal/web-kit';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { createSiteAuth } from '../site-auth.js';
import { StageFactoryContext } from './stage-factory.js';

type ViewerOptions = Parameters<ViewerFactory>[1];
type LoadOptions = Parameters<PanoViewer['load']>[1];
type PanoViewer = ReturnType<ViewerFactory>;

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

type Handler = (payload: string) => void;
class FakeViewer {
  handlers = new Map<string, Set<Handler>>();
  failLoad = false;
  constructor(readonly options: ViewerOptions) {}
  load = vi.fn(async (pano: string, _opts?: LoadOptions): Promise<boolean> => {
    if (this.failLoad) throw new Error('manifest 404');
    this.emit('scene-change', pano);
    return true;
  });
  transitionTo = vi.fn(async (pano: string) => this.emit('scene-change', pano));
  setView = vi.fn();
  getView = () => ({ yaw: 0, pitch: 0, fov: 70 });
  isSettled = () => false;
  focus = vi.fn();
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  dispose = vi.fn();
  onRender = () => () => {};
  project = () => ({ x: 0, y: 0, behind: false });
  heading = () => 0;
  prefetch = vi.fn(async () => {});
  on = (type: string, fn: Handler) => {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
  };
  off = (type: string, fn: Handler) => this.handlers.get(type)?.delete(fn);
  emit(type: string, payload: string) {
    this.handlers.get(type)?.forEach((fn) => fn(payload));
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
  return v as unknown as PanoViewer;
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
// What `GET /api/admin/tours/tour-a` answers: a status, or a thrown network error.
let adminTour: number | 'error';
const ownerBody = {
  tour: { tourId: 'tour-a', title: 'Old town', scenes: [{ panoId: 'square' }] },
  etag: 'e1',
  publish: null,
};
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/api/admin/')) {
    if (adminTour === 'error') throw new TypeError('network down');
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
  waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith(panoId));
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

describe('/s/:slug', () => {
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
    await waitFor(() =>
      expect(lastViewer().transitionTo).toHaveBeenCalledWith('church', { yaw: 1 }),
    );
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByText('Church').getAttribute('aria-current')).toBe('location');
  });

  it('loads CDN media inline and links media hosted elsewhere', async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      scenes: [
        scene('square', 'Square', [
          {
            id: 'm1',
            type: 'info',
            yaw: 0,
            pitch: 0,
            title: 'Plan',
            media: { kind: 'image', url: `${CDN}media/plan.jpg` },
          },
          {
            id: 'm2',
            type: 'info',
            yaw: 1,
            pitch: 0,
            title: 'Clip',
            media: { kind: 'video', url: 'https://other.test/clip.mp4' },
          },
        ]),
      ],
    });
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(screen.getByRole('complementary').querySelector('img')?.getAttribute('src')).toBe(
      `${CDN}media/plan.jpg`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clip' }));
    expect(screen.getByRole('complementary').querySelector('video')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open video ↗' }).getAttribute('href')).toBe(
      'https://other.test/clip.mp4',
    );
  });

  it('checks media URLs without URL.canParse (Safari 16)', async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      scenes: [
        scene('square', 'Square', [
          {
            id: 'm1',
            type: 'info',
            yaw: 0,
            pitch: 0,
            title: 'Plan',
            media: { kind: 'image', url: `${CDN}media/plan.jpg` },
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
      fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
      expect(screen.getByRole('complementary').querySelector('img')?.getAttribute('src')).toBe(
        `${CDN}media/plan.jpg`,
      );
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
    expect(lastViewer().options.autoRotate).toBe(true);
  });

  it('shows the compass and scene map by default', async () => {
    renderAt('/s/old-town');
    await screen.findByText('Old town');
    expect(screen.getByRole('img', { name: 'Compass' })).toBeTruthy();
    // Picking a scene before the first load lands would `load` it instead of `transitionTo`.
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Church' }));
    await waitFor(() =>
      expect(lastViewer().transitionTo).toHaveBeenCalledWith('church', undefined),
    );
  });

  it('adds noindex for an unlisted tour', async () => {
    objects['pub/tours/tour-a.json'] = bundle({ visibility: 'unlisted' });
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
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith('church'));
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

describe('/s/:slug/embed', () => {
  it('has no site chrome and keeps whole-tour navigation', async () => {
    renderAt('/s/old-town/embed');
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith('square'));
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

  it('limits ?pano= to one scene with no nav links', async () => {
    renderAt('/s/old-town/embed?pano=square');
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith('square'));
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
  it('opens the Link-only sheet with the canonical public URL', async () => {
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share this tour' });
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
    // The sheet is part of the page from the start: closed, it opens again.
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Share this tour' })).toBeTruthy();
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
    ['a non-owner (403)', 403],
    ['a missing tour (404)', 404],
    ['a server error', 500],
    ['a network error', 'error'],
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
    await waitFor(() => expect(lastViewer().transitionTo.mock.calls.at(-1)?.[0]).toBe('church'));
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

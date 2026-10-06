import type { ViewerFactory } from '@internal/ui';
import { loadConfig } from '@internal/web-kit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { StageFactoryContext } from './stage-factory.js';

type ViewerOptions = Parameters<ViewerFactory>[1];
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
  load = vi.fn(async (pano: string) => {
    if (this.failLoad) throw new Error('manifest 404');
    this.emit('scene-change', pano);
  });
  transitionTo = vi.fn(async (pano: string) => this.emit('scene-change', pano));
  setView = vi.fn();
  getView = () => ({ yaw: 0, pitch: 0, fov: 70 });
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  dispose = vi.fn();
  onRender = () => () => {};
  project = () => ({ x: 0, y: 0, behind: false });
  heading = () => 0;
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

let viewers: FakeViewer[];
let failLoads: boolean;
const createViewer: ViewerFactory = (_el, options) => {
  const v = new FakeViewer(options);
  v.failLoad = failLoads;
  viewers.push(v);
  return v as unknown as PanoViewer;
};
const lastViewer = () => viewers[viewers.length - 1]!;

let objects: Record<string, unknown>;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(CDN)) {
    const key = url.slice(CDN.length);
    return key in objects ? Response.json(objects[key]) : new Response('', { status: 404 });
  }
  if (url.startsWith('/api/tours/tour-a/')) {
    const liked = url.endsWith('/like');
    return Response.json(
      { views: 2400, likes: liked ? 8 : 7 },
      { status: init?.method ? 200 : 200 },
    );
  }
  return new Response('', { status: 500 });
});
const calls = (suffix: string) => fetchMock.mock.calls.filter(([u]) => String(u).endsWith(suffix));

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <StrictMode>
      <ConfigContext value={config}>
        <StageFactoryContext value={createViewer}>
          <RouterProvider router={router} />
        </StageFactoryContext>
      </ConfigContext>
    </StrictMode>,
  );
  return router;
}

const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute('content');
const shown = (panoId: string) =>
  waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith(panoId));
const unavailable = () => screen.findByRole('heading', { name: "This tour isn't available" });

beforeEach(() => {
  viewers = [];
  failLoads = false;
  objects = { 'slugs/old-town.json': live, 'pub/tours/tour-a.json': bundle() };
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
    expect(lastViewer().options.baseUrl).toBe(`${CDN}tiles/`);
    expect(document.title).toBe('Old town · panote');
    expect(robots()).toBeUndefined();
  });

  it('shows info points, their panel, and walks a link to the next scene', async () => {
    renderAt('/s/old-town');
    await shown('square');
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    const panel = screen.getByRole('complementary', { name: 'Fountain' });
    expect(panel.querySelector('strong')?.textContent).toBe('Old');
    expect(lastViewer().reportHotspotOpen).toHaveBeenCalledWith('i1');
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

  it('honours the tour settings', async () => {
    objects['pub/tours/tour-a.json'] = bundle({
      settings: { controls: 'top', showMap: false, showCompass: false, autoRotate: true },
    });
    renderAt('/s/old-town');
    await screen.findByText('Old town');
    expect(screen.getByRole('toolbar').className).toContain('pn-controls--top');
    expect(screen.queryByRole('img', { name: 'Compass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    expect(lastViewer().options.autoRotate).toBe(true);
  });

  it('shows the compass and scene map by default', async () => {
    renderAt('/s/old-town');
    await screen.findByText('Old town');
    expect(screen.getByRole('img', { name: 'Compass' })).toBeTruthy();
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
    const like = await screen.findByRole('button', { name: 'Like this tour' });
    fireEvent.click(like);
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

  it('starts at ?pano= on the full viewer, keeping navigation', async () => {
    renderAt('/s/old-town?pano=church');
    await shown('church');
    expect(screen.getByRole('button', { name: 'Map' })).toBeTruthy();
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
    expect(screen.queryByRole('navigation', { name: 'Tour' })).toBeNull();
    expect(document.querySelector('.app-shell__bar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Like this tour' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Go to To the church' })).toBeTruthy();
    expect(calls('/api/tours/tour-a/view')).toHaveLength(1);
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
    await waitFor(() => expect(robots()).toBe('noindex'));
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
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    window.dispatchEvent(new Event('pagehide'));
    const events = beacons();
    expect(events).toContainEqual({ type: 'scene', panoId: 'square', surface: 'embed' });
    expect(events).toContainEqual({
      type: 'hotspot',
      panoId: 'square',
      hotspotId: 'i1',
      surface: 'embed',
    });
    expect(calls('/events')).toHaveLength(0);
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

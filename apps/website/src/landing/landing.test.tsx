import type { ViewerFactory } from '@internal/ui';
import type * as webKit from '@internal/web-kit';
import { loadConfig, signInPath, type Auth } from '@internal/web-kit';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, renderSite } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { StageFactoryContext } from '../tour/stage-factory.js';

// Each test renders the whole site router, which is quick alone but ran past 5 s in CI's
// Coverage job, where every package's suite runs at once under V8 coverage (three
// different tests here, on two PRs). The work is the same; the runner is that much slower.
vi.setConfig({ testTimeout: 15_000 });

type LoadOptions = Parameters<ReturnType<ViewerFactory>['load']>[1];

const stash = vi.hoisted(() => vi.fn<(file: File) => Promise<boolean>>(async () => true));
vi.mock('@internal/web-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof webKit>()),
  stashPendingUpload: stash,
}));

const RESUME = '/app/new?resume=upload';
const CDN = 'https://cdn.test/';

const signedIn = () =>
  fakeAuth({
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => ({ name: 'Maya Larsson', email: 'maya@example.com' })),
  });

const dropTarget = () => screen.getByRole('link', { name: /^Upload a 360° photo free/ });

// The Shell and its pages are lazy routes: load their modules once up front, so the first
// test's queries don't time out on the module transform.
// The first render of a lazy page can take over the default 1s on a loaded CI runner
// (seen under coverage); only the wait gets longer, the assertions are unchanged.
configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await Promise.all([import('../Shell.js'), import('../pages.js')]);
});

afterEach(() => {
  cleanup();
  stash.mockClear();
  vi.unstubAllGlobals();
});

describe('landing', () => {
  it('says it is free and names no sign-in provider', async () => {
    renderSite('/');
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Host 360° tours at full resolution. Free.',
    );
    expect(dropTarget().textContent).toContain('free, sign in and start building');
    // Which providers sign-in offers is per environment; landing copy must not name one.
    expect(document.body.textContent).not.toMatch(/sign in with Google/i);
    expect(screen.queryByText(/no sign-up/i)).toBeNull();
    // Without a showcase tour there's no live hero or "See a live tour".
    expect(screen.queryByRole('link', { name: /See a live tour/ })).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('sends a signed-out upload through sign-in, back to the upload picker', async () => {
    const { auth, router } = renderSite('/');
    await screen.findByRole('link', { name: 'Sign in' });
    const href = signInPath(RESUME);
    expect(dropTarget().getAttribute('href')).toBe(href);
    expect(screen.getByRole('link', { name: 'Upload a photo' }).getAttribute('href')).toBe(href);
    expect(
      screen.getByRole('link', { name: 'Upload a 360° photo, free' }).getAttribute('href'),
    ).toBe(href);

    fireEvent.click(dropTarget());
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to panote' });
    expect(router.state.location.pathname).toBe('/');
    expect(stash).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with Google' }));
    expect(auth.signIn).toHaveBeenCalledWith({ connection: 'google-oauth2', returnTo: RESUME });
  });

  it('stashes a dropped file, then starts sign-in (Q1)', async () => {
    let stored!: (ok: boolean) => void;
    stash.mockImplementationOnce(() => new Promise((resolve) => (stored = resolve)));
    const { router } = renderSite('/');
    await screen.findByRole('link', { name: 'Sign in' });
    const file = new File(['x'], 'pano.jpg', { type: 'image/jpeg' });
    fireEvent.dragOver(dropTarget(), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(dropTarget().className).toContain('landing-drop--over');
    fireEvent.drop(dropTarget(), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(stash).toHaveBeenCalledWith(file);
    // Navigation waits for the stash to finish.
    expect(screen.queryByRole('dialog')).toBeNull();
    stored(true);
    expect(await screen.findByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(RESUME);
  });

  it('still starts sign-in when the stash fails or nothing was dropped', async () => {
    stash.mockResolvedValueOnce(false);
    const { router } = renderSite('/');
    await screen.findByRole('link', { name: 'Sign in' });
    const file = new File(['x'], 'pano.gif', { type: 'image/gif' });
    fireEvent.drop(dropTarget(), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(await screen.findByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(RESUME);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.drop(dropTarget(), { dataTransfer: { files: [], types: [] } });
    expect(await screen.findByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    expect(stash).toHaveBeenCalledTimes(1);
  });

  it('sends a signed-in upload straight to the admin app, without the sign-in pitch', async () => {
    renderSite('/', signedIn());
    await screen.findByRole('button', { name: 'Account: Maya Larsson' });
    const admin = `${LOCAL.admin}${RESUME}`;
    const drop = screen.getByRole('link', { name: /^Upload a 360° photo opens/ });
    expect(drop.getAttribute('href')).toBe(admin);
    expect(drop.textContent).toContain('Upload a 360° photo opens in your dashboard');
    expect(screen.getByRole('link', { name: 'Upload a photo' }).getAttribute('href')).toBe(admin);
    expect(screen.getByRole('link', { name: 'Upload a 360° photo' }).getAttribute('href')).toBe(
      admin,
    );
    expect(screen.queryByText(/free, sign in/)).toBeNull();
  });

  it('links the section nav and keeps one FAQ answer open at a time', async () => {
    renderSite('/');
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#features', '#how', '#showcase', '#faq']);
    for (const href of hrefs) expect(document.querySelector(href!)).toBeTruthy();

    const first = screen.getByRole('button', { name: 'Is it really free?' });
    const account = screen.getByRole('button', { name: 'Do I need an account?' });
    expect(first.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(account);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(account.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(account.getAttribute('aria-controls')!)?.textContent).toContain(
      'You sign in with an account you already have',
    );
  });

  it('states every account limit in the free answer, and makes no lasting promises', async () => {
    renderSite('/');
    const free = await screen.findByRole('button', { name: 'Is it really free?' });
    const answer = document.getElementById(free.getAttribute('aria-controls')!)?.textContent;
    for (const limit of [
      '500 panoramas',
      '200 tours',
      '20 GB per account',
      '50 uploads a day',
      '100 scenes per tour',
      '200 hotspots per scene',
      '150 MB',
    ])
      expect(answer).toContain(limit);
    // Tiling takes minutes, and the terms let the service change: neither "live in seconds"
    // nor "for as long as you want".
    expect(document.body.textContent).not.toMatch(
      /in seconds|as long as you want|never downscale/i,
    );
    expect(screen.getByRole('button', { name: 'Who can see my tours?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What happens if Panote shuts down?' })).toBeTruthy();
  });

  it('only shows the section nav on the landing', async () => {
    renderSite('/privacy');
    // Wait for the page itself, so the missing nav isn't just a page still loading.
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Upload a photo' })).toBeTruthy();
  });
});

describe('landing showcase', () => {
  const config = loadConfig({
    VITE_SITE_ORIGIN: 'https://panote.test',
    VITE_CDN_BASE: CDN,
    VITE_AUTH0_DOMAIN: 'tenant.auth0.com',
    VITE_AUTH0_CLIENT_ID: 'YOUR_CLIENT',
    VITE_AUTH0_AUDIENCE: 'https://api.test',
    VITE_SHOWCASE_SLUG: 'old-town',
  });
  const scene = (panoId: string) => ({ panoId, config: { panoId, title: panoId, hotspots: [] } });
  const bundle = {
    v: 1,
    tourId: 'tour-a',
    title: 'Old town',
    visibility: 'public',
    slug: 'old-town',
    publishedAt: '2026-09-20T00:00:00Z',
    settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
    startPanoId: 'church',
    scenes: [scene('square'), scene('church')],
  };
  const objects: Record<string, unknown> = {
    'slugs/old-town.json': { v: 1, kind: 'tour', tourId: 'tour-a' },
    'pub/tours/tour-a.json': bundle,
  };

  function renderWithShowcase(auth: Auth = fakeAuth()) {
    const loads: string[] = [];
    const options: Parameters<ViewerFactory>[1][] = [];
    const createViewer: ViewerFactory = (_el, opts) => {
      options.push(opts);
      const viewer = {
        load: vi.fn(async (id: string, _opts?: LoadOptions): Promise<boolean> => {
          loads.push(id);
          return true;
        }),
        setView: vi.fn(),
        setNorth: vi.fn(),
        setAutoRotate: vi.fn(),
        setLabel: vi.fn(),
        dispose: vi.fn(),
        on: vi.fn(() => () => {}),
        off: vi.fn(),
        onRender: () => () => {},
      };
      return viewer as unknown as ReturnType<ViewerFactory>;
    };
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });
    render(
      <ConfigContext value={config}>
        <StageFactoryContext value={createViewer}>
          <AuthEnvContext value={{ auth, origins: LOCAL }}>
            <RouterProvider router={router} />
          </AuthEnvContext>
        </StageFactoryContext>
      </ConfigContext>,
    );
    return { loads, options, router };
  }

  it('shows the showcase tour live behind the hero and links to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const key = String(input).slice(CDN.length);
        return key in objects ? Response.json(objects[key]) : new Response('', { status: 404 });
      }),
    );
    const { loads, options } = renderWithShowcase();
    const live = await screen.findByRole('link', { name: /See a live tour/ });
    expect(live.getAttribute('href')).toBe('/s/old-town');
    expect(screen.getByText('live · drag to look around')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Old town' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Walk through it/ }).getAttribute('href')).toBe(
      '/s/old-town',
    );
    await waitFor(() => expect(loads).toContain('church'));
    // The stage resolves scenes against the CDN's tiles.
    await expect(
      options[0]!.resolveSource!('church', new AbortController().signal),
    ).rejects.toThrow('manifest 404');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `${CDN}tiles/church/manifest.json`,
      expect.anything(),
    );
  });

  it('falls back to the plain hero when the showcase is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    renderWithShowcase();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /See a live tour/ })).toBeNull();
    expect(screen.queryByText('Featured tour')).toBeNull();
  });
});

describe('legal pages', () => {
  it('says visits are counted without personal data', async () => {
    renderSite('/privacy');
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy' })).toBeTruthy();
    const text = document.querySelector('.legal')?.textContent ?? '';
    expect(text).toContain('Visits are counted without personal data.');
    expect(text).toContain('Cloudflare Workers Analytics Engine');
    expect(text).toContain('no cookies for analytics');
  });

  it('renders the terms and the footer links between them', async () => {
    renderSite('/terms');
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms' })).toBeTruthy();
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe(
      '/privacy',
    );
  });
});

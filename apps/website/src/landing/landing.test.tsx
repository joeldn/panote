import type { ViewerFactory } from '@internal/ui';
import { loadConfig, signInPath, type Auth } from '@internal/web-kit';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, renderSite } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { StageFactoryContext } from '../tour/stage-factory.js';

const RESUME = '/app/new?resume=upload';
const CDN = 'https://cdn.test/';

const signedIn = () =>
  fakeAuth({
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => ({ name: 'Maya Larsson', email: 'maya@example.com' })),
  });

const dropTarget = () => screen.getByRole('link', { name: /^Upload your first tour free/ });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('landing', () => {
  it('says it is free and sign-in is with Google (Q1)', async () => {
    renderSite('/');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Your 360° tours. Full resolution. Free.',
    );
    expect(dropTarget().textContent).toContain('free — sign in with Google, live in seconds');
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
    expect(screen.getByRole('link', { name: 'Upload a pano' }).getAttribute('href')).toBe(href);
    expect(
      screen.getByRole('link', { name: /Upload your first tour — free/ }).getAttribute('href'),
    ).toBe(href);

    fireEvent.click(dropTarget());
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to panote' });
    expect(router.state.location.pathname).toBe('/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with Google' }));
    expect(auth.signIn).toHaveBeenCalledWith({ connection: 'google-oauth2', returnTo: RESUME });
  });

  it('starts sign-in when a file is dropped on the CTA', async () => {
    const { router } = renderSite('/');
    await screen.findByRole('link', { name: 'Sign in' });
    const file = new File(['x'], 'pano.jpg', { type: 'image/jpeg' });
    fireEvent.dragOver(dropTarget(), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(dropTarget().className).toContain('landing-drop--over');
    fireEvent.drop(dropTarget(), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(await screen.findByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(RESUME);
  });

  it('sends a signed-in upload straight to the admin app', async () => {
    renderSite('/', signedIn());
    await screen.findByRole('button', { name: 'Account: Maya Larsson' });
    const admin = `${LOCAL.admin}${RESUME}`;
    expect(dropTarget().getAttribute('href')).toBe(admin);
    expect(screen.getByRole('link', { name: 'Upload a pano' }).getAttribute('href')).toBe(admin);
  });

  it('links the section nav and keeps one FAQ answer open at a time', () => {
    renderSite('/');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
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
      'sign in with Google',
    );
  });

  it('only shows the section nav on the landing', () => {
    renderSite('/privacy');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Upload a pano' })).toBeTruthy();
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
        load: vi.fn(async (id: string) => void loads.push(id)),
        transitionTo: vi.fn(async () => {}),
        setView: vi.fn(),
        setNorth: vi.fn(),
        setAutoRotate: vi.fn(),
        dispose: vi.fn(),
        on: vi.fn(),
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
    expect(options[0]?.baseUrl).toBe(`${CDN}tiles/`);
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
  it('says visits are counted without personal data', () => {
    renderSite('/privacy');
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeTruthy();
    const text = document.querySelector('.legal')?.textContent ?? '';
    expect(text).toContain('Visits are counted without personal data.');
    expect(text).toContain('Cloudflare Workers Analytics Engine');
    expect(text).toContain('no cookies for analytics');
  });

  it('renders the terms and the footer links between them', () => {
    renderSite('/terms');
    expect(screen.getByRole('heading', { level: 1, name: 'Terms' })).toBeTruthy();
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe(
      '/privacy',
    );
  });
});

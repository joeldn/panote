import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL } from './__fixtures__/auth.js';
import { AuthEnvContext } from './auth-context.js';
import { page, reloadOnPreloadError, RELOAD_WINDOW_MS } from './chunk-reload.js';
import { routes } from './routes.js';

configure({ asyncUtilTimeout: 5000 });

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: https://panote.test/assets/Shell-old.js',
);

/** The real routes, with the Shell's lazy import failing the way a stale chunk does. */
function renderFailingShell(error: Error, { strict = false } = {}) {
  const [tour, embed, shell] = routes as [RouteObject, RouteObject, RouteObject];
  const failing = { ...shell, lazy: () => Promise.reject(error) } as RouteObject;
  const router = createMemoryRouter([tour, embed, failing], { initialEntries: ['/'] });
  const tree = (
    <AuthEnvContext value={{ auth: fakeAuth(), origins: LOCAL }}>
      <RouterProvider router={router} />
    </AuthEnvContext>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return router;
}

let reload: ReturnType<typeof vi.fn<() => void>>;
const failedCard = () => screen.findByRole('heading', { name: "This page couldn't be loaded" });

beforeEach(() => {
  sessionStorage.clear();
  reload = vi.fn<() => void>();
  vi.spyOn(page, 'reload').mockImplementation(reload);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a lazy Shell chunk that fails to load', () => {
  it('reloads the page once', async () => {
    const router = renderFailingShell(STALE);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(router.state.errors).not.toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('shows a retry card instead of reloading again right away', async () => {
    sessionStorage.setItem('panote:chunk-reload', String(Date.now() - 1000));
    renderFailingShell(STALE);
    expect(await failedCard()).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads once, and never shows the retry card, under StrictMode', async () => {
    renderFailingShell(STALE, { strict: true });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    // Give a stray second render or effect the chance to show the card or reload again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('heading')).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows the retry card when storage refuses the timestamp', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    renderFailingShell(STALE);
    expect(await failedCard()).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again once the window has passed', async () => {
    sessionStorage.setItem('panote:chunk-reload', String(Date.now() - RELOAD_WINDOW_MS - 1));
    renderFailingShell(STALE);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it('never reloads without session storage to guard the loop', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderFailingShell(STALE);
    expect(await failedCard()).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows the retry card for an error that is not a chunk load', async () => {
    renderFailingShell(new Error('boom'));
    expect(await failedCard()).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('vite:preloadError', () => {
  it('reloads once and swallows the error, then lets a repeat through', () => {
    const stop = reloadOnPreloadError();
    try {
      const first = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(first);
      expect(reload).toHaveBeenCalledOnce();
      expect(first.defaultPrevented).toBe(true);

      const second = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(second);
      expect(reload).toHaveBeenCalledOnce();
      expect(second.defaultPrevented).toBe(false);
    } finally {
      stop();
    }
  });
});

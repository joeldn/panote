import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AuthRequiredError,
  createAuth,
  type Auth,
  type Auth0Like,
  type FetchLike,
} from '@internal/web-kit';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, renderAdmin, USER } from './__fixtures__/auth.js';
import { AuthEnvContext } from './auth-context.js';
import { RequireAuth } from './RequireAuth.js';
import { createSessionApi, useSession } from './session.js';

afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('route guard', () => {
  it('sends a signed-out user to the website sign-in with next = the current path', async () => {
    const auth = fakeAuth({ isAuthenticated: vi.fn(async () => false) });
    const { assign } = renderAdmin('/app/t/abc?pano=p1#view', { auth });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const url = new URL(assign.mock.calls[0]![0]);
    expect(url.origin).toBe('http://localhost:5174');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('signin')).toBe('1');
    expect(url.searchParams.get('next')).toBe('/app/t/abc?pano=p1#view');
    expect(screen.queryByRole('heading', { name: /Editor/ })).toBeNull();
  });

  it('uses the shared origin when deployed', async () => {
    const auth = fakeAuth({ isAuthenticated: vi.fn(async () => false) });
    const deployed = { website: 'https://panote.dev', admin: 'https://panote.dev' };
    const { assign } = renderAdmin('/app/', { auth, origins: deployed });
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://panote.dev/?signin=1&next=%2Fapp%2F'),
    );
  });

  it('shows a retryable error when the session check itself fails', async () => {
    const isAuthenticated = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(true);
    renderAdmin('/app/', { auth: fakeAuth({ isAuthenticated }) });
    expect((await screen.findByRole('alert')).textContent).toContain('chunk failed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  });
});

describe('callback', () => {
  it('finishes the redirect and navigates in-app, keeping the query (Q1 resume flag)', async () => {
    const auth = fakeAuth({ handleCallback: vi.fn(async () => '/app/new?resume=upload') });
    const { assign, router } = renderAdmin('/app/callback?code=c&state=s', { auth, strict: true });
    expect((await screen.findByRole('dialog')).textContent).toBe('Upload');
    // The code is single-use, so StrictMode's double effect must not redeem it twice.
    expect(auth.handleCallback).toHaveBeenCalledTimes(1);
    expect(router.state.location.search).toBe('?resume=upload');
    expect(assign).not.toHaveBeenCalled();
  });

  it('leaves the admin app with a full navigation for a website path', async () => {
    const auth = fakeAuth({ handleCallback: vi.fn(async () => '/s/my-tour') });
    const { assign } = renderAdmin('/app/callback?code=c&state=s', { auth });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:5174/s/my-tour'));
  });

  it('shows the Auth0 error with a way back to sign-in', async () => {
    const auth = fakeAuth({
      handleCallback: vi.fn(async () => {
        throw new Error('access_denied: user cancelled');
      }),
    });
    renderAdmin('/app/callback?error=access_denied&state=s', { auth });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sign-in didn’t complete');
    expect(alert.textContent).toContain('user cancelled');
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(
      'http://localhost:5174/?signin=1',
    );
  });

  it.each(['https://evil.example/x', '//evil.example/x', '/\\evil.example'])(
    'never follows an off-site returnTo from appState (%s)',
    async (returnTo) => {
      const client: Auth0Like = {
        loginWithRedirect: vi.fn(async () => {}),
        handleRedirectCallback: vi.fn(async () => ({ appState: { returnTo } })),
        getTokenSilently: vi.fn(async () => 'jwt'),
        isAuthenticated: vi.fn(async () => true),
        getUser: vi.fn(async () => USER),
        logout: vi.fn(async () => {}),
      };
      const auth = createAuth(
        {
          domain: 'panote-dev.au.auth0.com',
          clientId: 'client',
          audience: 'https://api.panote.dev',
          connections: ['google-oauth2'],
          configured: true,
        },
        { redirectUri: 'http://localhost:5173/app/callback', createClient: async () => client },
      );
      const { assign } = renderAdmin('/app/callback?code=c&state=s', { auth });
      expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
      expect(assign).not.toHaveBeenCalled();
    },
  );
});

describe('account menu', () => {
  it('shows the user and signs out back to the website', async () => {
    const auth = fakeAuth();
    renderAdmin('/app/', { auth });
    const avatar = await screen.findByRole('button', { name: 'Account: Maya Larsson' });
    expect(avatar.textContent).toBe('M');
    fireEvent.click(avatar);
    expect(screen.getByRole('menu').textContent).toContain('maya@example.com');
    expect(screen.getByRole('menuitem', { name: 'Home page' }).getAttribute('href')).toBe(
      'http://localhost:5174/',
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledWith('http://localhost:5174/');
  });

  it('the callback is not guarded and shows no account menu', async () => {
    const auth = fakeAuth({
      isAuthenticated: vi.fn(async () => false),
      handleCallback: () => new Promise(() => {}),
    });
    const { assign } = renderAdmin('/app/callback?code=c&state=s', { auth });
    expect((await screen.findByRole('status')).textContent).toBe('Signing you in…');
    expect(screen.queryByRole('button', { name: /Account/ })).toBeNull();
    expect(auth.isAuthenticated).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('unconfigured auth', () => {
  it('explains instead of redirecting or crashing', async () => {
    const auth = fakeAuth({ configured: false, connections: [] });
    const { assign } = renderAdmin('/app/t/abc', { auth });
    expect((await screen.findByRole('alert')).textContent).toContain('isn’t set up here');
    expect(auth.isAuthenticated).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    cleanup();
    renderAdmin('/app/callback?code=c', { auth });
    expect((await screen.findByRole('alert')).textContent).toContain('isn’t set up here');
    expect(auth.handleCallback).not.toHaveBeenCalled();
  });
});

describe('session API', () => {
  it('sends the Auth0 access token as the bearer token', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ tours: [], cursor: null }));
    const auth = fakeAuth();
    const api = createSessionApi(auth, vi.fn(), { baseUrl: '', fetch });
    await expect(api.listTours()).resolves.toEqual({ tours: [], cursor: null });
    expect(auth.getAccessToken).toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/admin/tours');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer jwt-token');
  });

  it('reports a gone session or an API 401, and rethrows', async () => {
    const onAuthError = vi.fn();
    const gone = fakeAuth({ getAccessToken: vi.fn().mockRejectedValue(new AuthRequiredError()) });
    const fetch = vi.fn<FetchLike>(async () => json({ error: 'unauthorized' }, 401));
    await expect(
      createSessionApi(gone, onAuthError, { baseUrl: '', fetch }).listTours(),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      createSessionApi(fakeAuth(), onAuthError, { baseUrl: '', fetch }).listTours(),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(onAuthError).toHaveBeenCalledTimes(2);
  });

  it('does not report other failures', async () => {
    const onAuthError = vi.fn();
    const fetch = vi.fn<FetchLike>(async () => json({ error: 'boom' }, 500));
    await expect(
      createSessionApi(fakeAuth(), onAuthError, { baseUrl: '', fetch }).listTours(),
    ).rejects.toThrow('500');
    expect(onAuthError).not.toHaveBeenCalled();
  });
});

describe('session gone mid-session', () => {
  function Probe() {
    const { api } = useSession();
    const [result, setResult] = useState('idle');
    return (
      <button
        type="button"
        onClick={() =>
          api.listTours().then(
            () => setResult('ok'),
            (e: Error) => setResult(e.name),
          )
        }
      >
        load: {result}
      </button>
    );
  }

  const renderProbe = (auth: Auth, fetch: FetchLike) => {
    const router = createMemoryRouter(
      [{ element: <RequireAuth />, children: [{ path: '*', element: <Probe /> }] }],
      { basename: '/app', initialEntries: ['/app/t/abc?pano=p2'] },
    );
    render(
      <AuthEnvContext value={{ auth, origins: LOCAL, assign: vi.fn(), apiBase: '', fetch }}>
        <RouterProvider router={router} />
      </AuthEnvContext>,
    );
  };

  it('prompts sign-in in place and returns to the current page', async () => {
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('jwt-token')
      .mockRejectedValue(new AuthRequiredError());
    const auth = fakeAuth({ getAccessToken });
    const fetch = vi.fn<FetchLike>(async () => json({ tours: [], cursor: null }));
    renderProbe(auth, fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'load: idle' }));
    expect(await screen.findByRole('button', { name: 'load: ok' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'load: ok' }));
    const dialog = await screen.findByRole('dialog', { name: 'Your session has ended' });
    expect(dialog.textContent).toContain('Sign in again to continue.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(auth.signIn).toHaveBeenCalledWith({
      connection: 'google-oauth2',
      returnTo: '/app/t/abc?pano=p2',
    });
  });

  it('prompts on an API 401 too', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ error: 'unauthorized' }, 401));
    renderProbe(fakeAuth(), fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'load: idle' }));
    expect(await screen.findByRole('dialog', { name: 'Your session has ended' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'load: AuthRequiredError' })).toBeTruthy();
  });
});

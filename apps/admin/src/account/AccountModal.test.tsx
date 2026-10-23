import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer } from '../__fixtures__/editor-server.js';
import { formatBytes } from '../dashboard/format.js';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const USAGE = {
  panos: 12,
  bytes: 3 * 1024 ** 3,
  uploadsToday: 48,
  limits: { maxPanos: 500, maxBytes: 20 * 1024 ** 3, maxUploadsPerDay: 50 },
};

const ACCOUNT = {
  email: 'maya@example.com',
  signIns: ['google-oauth2', 'email', 'windowslive', 'unknown-idp', 'constructor'],
};

const tourPage = (n: number, cursor: string | null) =>
  json({
    tours: Array.from({ length: n }, (_, i) => ({
      tourId: `t${i}`,
      title: `Tour ${i}`,
      sceneCount: 1,
      coverPanoId: null,
      updatedAt: '2026-10-20T00:00:00Z',
      etag: 'e',
      publish: null,
    })),
    cursor,
  });

/** What the account window reads: the account, usage, and the owner's tours to count. */
function accountAnswer(url: URL, method: string): Response | undefined {
  const key = `${method} ${url.pathname}`;
  if (key === 'GET /api/admin/account') return json(ACCOUNT);
  if (key === 'GET /api/upload-url') return json(USAGE);
  if (key === 'GET /api/admin/tours' && url.searchParams.get('limit') === '100') {
    return url.searchParams.get('cursor') ? tourPage(3, null) : tourPage(100, 'c2');
  }
  return undefined;
}

function server(over: Partial<Record<string, () => Response>> = {}) {
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const method = init.method ?? 'GET';
    const answer = over[`${method} ${url.pathname}`];
    if (answer) return answer();
    const account = accountAnswer(url, method);
    if (account) return account;
    if (url.pathname === '/api/admin/tours') return tourPage(0, null); // the dashboard
    if (url.pathname === '/api/admin/panos') return json({ panoIds: [], panos: [], cursor: null });
    if (url.pathname === '/api/admin/shared-tours') return json({ tours: [] });
    throw new Error(`unexpected ${method} ${url.pathname}`);
  });
}

const accountCalls = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls.filter(
    ([u]) => new URL(String(u), 'https://panote.test').pathname === '/api/admin/account',
  ).length;

const openMenu = async () =>
  fireEvent.click(await screen.findByRole('button', { name: /^Account: / }));

async function openAccount() {
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Account…' }));
  return within(await screen.findByRole('dialog', { name: 'Account' }));
}

describe('the account window', () => {
  it('opens from the menu over the dashboard, without leaving it', async () => {
    const fetch = server();
    const { router } = renderAdmin('/app/', { fetch });
    const dialog = await openAccount();
    expect(router.state.location.pathname).toBe('/app/');
    expect(screen.getByRole('heading', { name: /^Welcome/ })).toBeTruthy();

    expect(await dialog.findByText('maya@example.com')).toBeTruthy();
    expect(
      dialog.getByText('Google, Email code, Microsoft, unknown-idp, constructor'),
    ).toBeTruthy();
    const usage = within(dialog.getByRole('region', { name: 'Usage' }));
    expect(await usage.findByText('12 of 500')).toBeTruthy();
    expect(usage.getByText('3 GB of 20 GB')).toBeTruthy();
    expect(usage.getByText('48 of 50')).toBeTruthy();
    // Both pages of tours, counted.
    expect(usage.getByText('103 of 200')).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes('cursor=c2'))).toBe(true);

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
    expect(router.state.location.pathname).toBe('/app/');
  });

  it('closes when another page takes over, and hands focus back to the avatar', async () => {
    const { router } = renderAdmin('/app/', { fetch: server() });
    await openAccount();
    // Back or forward to another page under the same bar: the window stays with its page.
    await act(() => router.navigate('/panos/unused'));
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
    await act(() => router.navigate('/'));
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();

    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Account: /),
    );
  });

  it('opens over the editor, keeping its unsaved edits and its address', async () => {
    const editor = new FakeServer();
    editor.setTour({ tourId: 'tour-1', title: 'Tour one', scenes: [] });
    editor.intercept = (r) => {
      const url = new URL(r.path, 'https://panote.test');
      return accountAnswer(url, r.method);
    };
    const { router } = renderAdmin('/app/t/tour-1', { fetch: editor.fetch });
    fireEvent.click(await screen.findByRole('button', { name: /Tour title: Tour one/ }));
    const title = screen.getByRole('textbox', { name: 'Tour title' });
    fireEvent.change(title, { target: { value: 'Tour two' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(await screen.findByRole('button', { name: /Tour title: Tour two/ })).toBeTruthy();

    const dialog = await openAccount();
    expect(await dialog.findByText('maya@example.com')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
    expect(screen.getByRole('button', { name: /Tour title: Tour two/ })).toBeTruthy();
  });

  it('opens at /app/account for old links, and closing it leaves the dashboard', async () => {
    const { router } = renderAdmin('/app/account', { fetch: server() });
    const dialog = within(await screen.findByRole('dialog', { name: 'Account' }));
    expect(await dialog.findByText('maya@example.com')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Welcome/ })).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    // The dashboard's own address (the basename, with or without its slash).
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/app\/?$/));
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
  });

  it('shows the account ID, copies it, and fills it into the support email', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAdmin('/app/', { fetch: server() });
    const dialog = await openAccount();
    const id = within(dialog.getByRole('region', { name: 'Account ID' }));
    expect(id.getByText('google-oauth2|1')).toBeTruthy();
    fireEvent.click(id.getByRole('button', { name: 'Copy account ID' }));
    expect(await id.findByRole('button', { name: 'Copied ✓' })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('google-oauth2|1');

    const href = dialog.getByRole('link', { name: 'Contact support' }).getAttribute('href')!;
    expect(href.startsWith('mailto:hello@panote.io?')).toBe(true);
    const body = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('body');
    expect(body).toBe('Account ID: google-oauth2|1\r\n\r\nWhat happened:\r\n');
  });

  it('says the email is not verified when the token has none', async () => {
    renderAdmin('/app/', {
      fetch: server({
        'GET /api/admin/account': () => json({ email: null, signIns: ['windowslive'] }),
      }),
    });
    const dialog = await openAccount();
    expect(await dialog.findByText('Not verified')).toBeTruthy();
  });

  it('shows a count with no bar for a limit that is not set', async () => {
    renderAdmin('/app/', {
      fetch: server({
        'GET /api/upload-url': () =>
          json({ ...USAGE, limits: { ...USAGE.limits, maxUploadsPerDay: null } }),
      }),
    });
    const usage = within((await openAccount()).getByRole('region', { name: 'Usage' }));
    const row = (await usage.findByText('Uploads, past 24 h')).closest('li')!;
    expect(row.textContent).toBe('Uploads, past 24 h48');
    expect(row.querySelector('.acct__bar')).toBeNull();
  });

  it('offers a retry when usage fails to load', async () => {
    let fail = true;
    renderAdmin('/app/', {
      fetch: server({
        'GET /api/upload-url': () =>
          fail ? json({ error: 'storage unavailable' }, 502) : json(USAGE),
      }),
    });
    const dialog = await openAccount();
    const alert = await dialog.findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t load your usage.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await dialog.findByText('12 of 500')).toBeTruthy();
  });

  it('signs out', async () => {
    const auth = fakeAuth();
    renderAdmin('/app/', { auth, fetch: server() });
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });

  it('opens Delete account over it, and Cancel comes back to it', async () => {
    renderAdmin('/app/', { fetch: server() });
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole('button', { name: 'Delete account' }));
    expect(await screen.findByRole('dialog', { name: 'Delete your account?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Delete your account?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeTruthy();
  });
});

describe('the account menu', () => {
  it('has Account… and Sign out (not drawn as danger), and nothing the window already has', async () => {
    const auth = fakeAuth();
    renderAdmin('/app/', { auth, fetch: server() });
    await openMenu();
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Account…', 'Sign out']);
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' });
    expect(signOut.className).toBe('pn-account__item');
    fireEvent.click(signOut);
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });

  it('goes to Operations from the window opened at /app/account', async () => {
    const operator = server({
      'GET /api/admin/account': () => json({ ...ACCOUNT, operator: true }),
    });
    const { router } = renderAdmin('/app/account', { fetch: operator });
    const dialog = within(await screen.findByRole('dialog', { name: 'Account' }));
    fireEvent.click(await dialog.findByRole('link', { name: 'Operations' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/ops'));
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
  });

  it('lists Operations for an operator only, and goes there', async () => {
    const operator = server({
      'GET /api/admin/account': () => json({ ...ACCOUNT, operator: true }),
    });
    const { router } = renderAdmin('/app/', { fetch: operator });
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Operations' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/ops'));
    cleanup();

    const fetch = server();
    renderAdmin('/app/', { fetch });
    await screen.findByRole('heading', { name: /^Welcome/ });
    // Not asked on page load, only once the menu opens.
    expect(accountCalls(fetch)).toBe(0);
    await openMenu();
    await waitFor(() => expect(accountCalls(fetch)).toBe(1));
    // Closed and opened again: the answer is in, it's no, and it isn't asked twice.
    await openMenu();
    await openMenu();
    await screen.findByRole('menuitem', { name: 'Account…' });
    expect(screen.queryByRole('menuitem', { name: 'Operations' })).toBeNull();
    expect(accountCalls(fetch)).toBe(1);
  });
});

describe('formatBytes', () => {
  it('uses GB from one GiB up, MB below', () => {
    expect(formatBytes(20 * 1024 ** 3)).toBe('20 GB');
    expect(formatBytes(1.55 * 1024 ** 3)).toBe('1.6 GB');
    expect(formatBytes(340 * 1024 ** 2)).toBe('340 MB');
    expect(formatBytes(0)).toBe('0 MB');
  });
});

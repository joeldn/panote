import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
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

function server(over: Partial<Record<string, () => Response>> = {}) {
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
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const answer = over[key];
    if (answer) return answer();
    if (key === 'GET /api/admin/account') {
      return json({
        email: 'maya@example.com',
        signIns: ['google-oauth2', 'email', 'windowslive', 'unknown-idp', 'constructor'],
      });
    }
    if (key === 'GET /api/upload-url') return json(USAGE);
    if (key === 'GET /api/admin/tours') {
      if (url.searchParams.get('limit') !== '100') return tourPage(0, null); // the dashboard
      return url.searchParams.get('cursor') ? tourPage(3, null) : tourPage(100, 'c2');
    }
    if (key === 'GET /api/admin/panos') return json({ panoIds: [], panos: [], cursor: null });
    if (key === 'GET /api/admin/shared-tours') return json({ tours: [] });
    throw new Error(`unexpected ${key}`);
  });
}

describe('the account page', () => {
  it('shows the email, the sign-in methods and usage against each limit', async () => {
    const fetch = server();
    renderAdmin('/app/account', { fetch });
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeTruthy();
    expect(await screen.findByText('maya@example.com')).toBeTruthy();
    expect(
      screen.getByText('Google, Email code, Microsoft, unknown-idp, constructor'),
    ).toBeTruthy();

    const usage = within(screen.getByRole('region', { name: 'Usage' }));
    expect(await usage.findByText('12 of 500')).toBeTruthy();
    expect(usage.getByText('3 GB of 20 GB')).toBeTruthy();
    expect(usage.getByText('48 of 50')).toBeTruthy();
    // Both pages of tours, counted.
    expect(usage.getByText('103 of 200')).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes('cursor=c2'))).toBe(true);
  });

  it('shows the account ID and a support email with it filled in', async () => {
    renderAdmin('/app/account', { fetch: server() });
    const help = within(await screen.findByRole('region', { name: 'Help' }));
    expect(help.getByText('google-oauth2|1')).toBeTruthy();
    const href = help.getByRole('link', { name: 'Contact support' }).getAttribute('href')!;
    expect(href.startsWith('mailto:hello@panote.io?')).toBe(true);
    const body = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('body');
    expect(body).toBe('Account ID: google-oauth2|1\r\n\r\nWhat happened:\r\n');
  });

  it('says the email is not verified when the token has none', async () => {
    renderAdmin('/app/account', {
      fetch: server({
        'GET /api/admin/account': () => json({ email: null, signIns: ['windowslive'] }),
      }),
    });
    expect(await screen.findByText('Not verified')).toBeTruthy();
  });

  it('shows a count with no bar for a limit that is not set', async () => {
    renderAdmin('/app/account', {
      fetch: server({
        'GET /api/upload-url': () =>
          json({ ...USAGE, limits: { ...USAGE.limits, maxUploadsPerDay: null } }),
      }),
    });
    const usage = within(await screen.findByRole('region', { name: 'Usage' }));
    const row = (await usage.findByText('Uploads in the past 24 hours')).closest('li')!;
    expect(row.textContent).toBe('Uploads in the past 24 hours48');
    expect(row.querySelector('.acct__bar')).toBeNull();
  });

  it('offers a retry when usage fails to load', async () => {
    let fail = true;
    renderAdmin('/app/account', {
      fetch: server({
        'GET /api/upload-url': () =>
          fail ? json({ error: 'storage unavailable' }, 502) : json(USAGE),
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t load your usage.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('12 of 500')).toBeTruthy();
  });

  it('signs out, and opens the delete dialog', async () => {
    const auth = fakeAuth();
    renderAdmin('/app/account', { auth, fetch: server() });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    expect(await screen.findByRole('dialog', { name: 'Delete your account?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });

  it('is in the account menu', async () => {
    const { router } = renderAdmin('/app/', { fetch: server() });
    fireEvent.click(await screen.findByRole('button', { name: /^Account: / }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/account'));
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

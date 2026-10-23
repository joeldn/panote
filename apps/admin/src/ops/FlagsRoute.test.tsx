import type { FlagRecord } from '@internal/contracts';
import { cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const flag = (flagId: string, over: Partial<FlagRecord> = {}): FlagRecord => ({
  v: 1,
  flagId,
  source: 'viewer',
  tourId: 't1',
  slug: 'old-town',
  panoId: 'p1',
  reason: 'spam',
  at: '2026-10-22T09:30:00.000Z',
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(flags: FlagRecord[], over: Record<string, (body: unknown) => Response> = {}) {
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const answer = over[key];
    if (answer) return answer(init.body ? JSON.parse(String(init.body)) : undefined);
    if (key === 'GET /api/admin/account') {
      return json({ email: null, signIns: ['google-oauth2'], operator: true });
    }
    if (key === 'GET /api/admin/ops/flags') return json({ flags, more: false });
    throw new Error(`unexpected ${key}`);
  });
}

describe('/app/ops/flags', () => {
  it('groups flags by panorama, with reasons, notes and a link to the scene', async () => {
    renderAdmin('/app/ops/flags', {
      fetch: server([
        flag('a', { reason: 'sexual', note: 'left wall' }),
        flag('b', { reason: 'sexual', at: '2026-10-21T00:00:00.000Z' }),
        flag('c', { panoId: 'p2', reason: 'privacy' }),
      ]),
    });
    const link = await screen.findByRole('link', { name: 'old-town · p1' });
    expect(link.getAttribute('href')).toBe('http://localhost:5174/s/old-town?pano=p1');
    expect(screen.getByText('Sexual ×2 · last 2026-10-22 09:30')).toBeTruthy();
    expect(screen.getByText('“left wall”')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'old-town · p2' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Flags' })).toBeTruthy();
  });

  it('dismisses every flag on a panorama at once', async () => {
    const fetch = server([flag('a'), flag('b'), flag('c', { panoId: 'p2' })], {
      'POST /api/admin/ops/flags/dismiss': () =>
        json({ flags: [flag('c', { panoId: 'p2' })], more: false }),
    });
    renderAdmin('/app/ops/flags', { fetch });
    await screen.findByRole('link', { name: 'old-town · p1' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'old-town · p1' })).toBeNull());
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ flagIds: ['a', 'b'] });
  });

  it('finds the tour’s owner and opens them on the Users page', async () => {
    const fetch = server([flag('a')], {
      'GET /api/admin/ops/users/lookup': () =>
        json({ sub: 'google-oauth2|42', via: 'tour', tourId: 't1' }),
    });
    const { router } = renderAdmin('/app/ops/flags', { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Find owner' }));
    await waitFor(() =>
      expect(router.state.location.search).toBe(`?sub=${encodeURIComponent('google-oauth2|42')}`),
    );
    expect(router.state.location.pathname).toBe('/app/ops/users');
  });

  it('says so when there are none', async () => {
    renderAdmin('/app/ops/flags', { fetch: server([]) });
    expect(await screen.findByText('No flags.')).toBeTruthy();
  });
});

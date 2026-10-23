import type { ExplorePending } from '@internal/contracts';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const tour = (tourId: string, over: Partial<ExplorePending> = {}): ExplorePending => ({
  v: 1,
  tourId,
  slug: `${tourId}-slug`,
  title: `Tour ${tourId}`,
  sceneCount: 3,
  cover: { panoId: `${tourId}-p`, version: 't1-abc', image: 'og' },
  fingerprint: `fp-${tourId}`,
  reason: 'new',
  queuedAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:00.000Z',
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function server(
  tours: ExplorePending[],
  over: Record<string, (body: unknown) => Response> = {},
  operator = true,
) {
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const answer = over[key];
    if (answer) return answer(init.body ? JSON.parse(String(init.body)) : undefined);
    if (key === 'GET /api/admin/account') {
      return json({ email: null, signIns: ['google-oauth2'], operator });
    }
    if (key === 'GET /api/admin/ops/explore') return json({ tours });
    throw new Error(`unexpected ${key}`);
  });
}

const posts = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([u, init]) => [new URL(String(u), 'https://x').pathname, JSON.parse(String(init!.body))]);

describe('/app/ops/explore', () => {
  it('lists the tours waiting, with their cover, link and why they wait', async () => {
    renderAdmin('/app/ops/explore', {
      fetch: server([tour('t1'), tour('t2', { reason: 'changed', cover: null, title: '' })]),
    });
    const link = await screen.findByRole('link', { name: 'Tour t1' });
    expect(link.getAttribute('href')).toBe('http://localhost:5174/s/t1-slug');
    expect(screen.getByText('New · 3 scene(s) · Waiting since 2026-10-20')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Untitled tour' })).toBeTruthy();
    expect(screen.getByText(/^Changed since approved/)).toBeTruthy();
    const img = document.querySelector('img.queue__cover');
    expect(img?.getAttribute('src')).toMatch(/\/tiles\/t1-p\/t1-abc\/og\.jpg$/);
    expect(screen.getByRole('link', { name: 'Explore queue' })).toBeTruthy();
  });

  it('says so when nothing is waiting', async () => {
    renderAdmin('/app/ops/explore', { fetch: server([]) });
    expect(await screen.findByText('Nothing waiting.')).toBeTruthy();
  });

  it('approves and rejects with the fingerprint it showed, then shows the queue as it is', async () => {
    const fetch = server([tour('t1'), tour('t2')], {
      'POST /api/admin/ops/explore/t1': () => json({ tours: [tour('t2')] }),
      'POST /api/admin/ops/explore/t2': () => json({ tours: [] }),
    });
    renderAdmin('/app/ops/explore', { fetch });
    const row = (await screen.findByRole('link', { name: 'Tour t1' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Tour t1' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Nothing waiting.')).toBeTruthy();
    expect(posts(fetch)).toEqual([
      ['/api/admin/ops/explore/t1', { action: 'approve', fingerprint: 'fp-t1' }],
      ['/api/admin/ops/explore/t2', { action: 'reject', fingerprint: 'fp-t2' }],
    ]);
  });

  it('a tour changed since it loaded is refused, and the queue reloads', async () => {
    let gets = 0;
    const fetch = server([], {
      'GET /api/admin/ops/explore': () => {
        gets += 1;
        return json({ tours: [tour('t1', gets > 1 ? { fingerprint: 'fp-new' } : {})] });
      },
      'POST /api/admin/ops/explore/t1': () => json({ error: 'tour changed since you looked' }, 409),
    });
    renderAdmin('/app/ops/explore', { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '“Tour t1” changed since you looked. Check it again before deciding.',
    );
    await waitFor(() => expect(gets).toBe(2));
  });

  it('asks for a fresh sign-in when the last one is too old', async () => {
    const fetch = server([tour('t1')], {
      'POST /api/admin/ops/explore/t1': () => json({ error: 'reauthentication required' }, 403),
    });
    renderAdmin('/app/ops/explore', { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in again to decide' })).toBeTruthy();
  });

  it('is not found for anyone but an operator', async () => {
    const fetch = server([tour('t1')], {}, false);
    renderAdmin('/app/ops/explore', { fetch });
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/ops/explore'))).toBe(false);
  });
});

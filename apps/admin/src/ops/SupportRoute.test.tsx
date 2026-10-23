import type { SupportUserView } from '@internal/contracts';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const SUB = 'google-oauth2|42';
const ENCODED = encodeURIComponent(SUB);

const USER: SupportUserView = {
  sub: SUB,
  since: '2026-09-01T10:00:00.000Z',
  disabled: null,
  deletion: null,
  usage: { panos: 3, bytes: 1024 ** 3, uploadsToday: 2, tours: 1 },
  limits: { maxPanos: 500, maxBytes: 20 * 1024 ** 3, maxTours: 200 },
  tours: [
    {
      tourId: 't1',
      title: 'Old town',
      sceneCount: 4,
      updatedAt: '2026-10-20T00:00:00.000Z',
      publish: { slug: 'old-town', visibility: 'public' },
      hiddenFromExplore: false,
      editors: 1,
      transferring: false,
    },
  ],
  editsTours: [],
  trash: [{ date: '2026-10-22', key: `panos/x/p9/original`, panoId: 'p9', bytes: 2048 }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function server(over: Record<string, (body: unknown) => Response> = {}) {
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const answer = over[key];
    if (answer) return answer(init.body ? JSON.parse(String(init.body)) : undefined);
    if (key === 'GET /api/admin/account') {
      return json({ email: null, signIns: ['google-oauth2'], operator: true });
    }
    if (key === 'GET /api/admin/ops/users/lookup') {
      return url.searchParams.get('q') === 'https://panote.io/s/old-town'
        ? json({ sub: SUB, via: 'slug', tourId: 't1' })
        : json({ error: 'not found' }, 404);
    }
    if (key === `GET /api/admin/ops/users/${ENCODED}`) return json(USER);
    throw new Error(`unexpected ${key}`);
  });
}

const posts = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([u, init]) => [new URL(String(u), 'https://x').pathname, JSON.parse(String(init!.body))]);

describe('/app/ops/users', () => {
  it('finds an account by its share link and shows it', async () => {
    renderAdmin('/app/ops/users', { fetch: server() });
    const input = await screen.findByLabelText('Find an account');
    fireEvent.change(input, { target: { value: 'nothing-here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText(/Nothing found/)).toBeTruthy();

    fireEvent.change(input, { target: { value: 'https://panote.io/s/old-town' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const account = within(await screen.findByRole('region', { name: 'Account' }));
    expect(account.getByText(SUB)).toBeTruthy();
    expect(account.getByText('Active')).toBeTruthy();
    expect(account.getByText('3 of 500')).toBeTruthy();
    const tours = within(screen.getByRole('region', { name: 'Tours' }));
    expect(tours.getByRole('link', { name: 'Old town' }).getAttribute('href')).toBe(
      'http://localhost:5174/s/old-town',
    );
    expect(tours.getByText(/Public · 1 editor\(s\)/)).toBeTruthy();
  });

  it('disables with a reason, and shows the account as it is now', async () => {
    const fetch = server({
      [`POST /api/admin/ops/users/${ENCODED}/disable`]: (body) =>
        json({
          ...USER,
          disabled: {
            disabledAt: '2026-10-23T10:00:00Z',
            reason: (body as { reason: string }).reason,
          },
        }),
    });
    renderAdmin(`/app/ops/users?sub=${ENCODED}`, { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Disable account' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Disable this account?' }));
    const confirm = dialog.getByRole('button', { name: 'Disable' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/Reason/), { target: { value: ' case 3 ' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('Disabled since 2026-10-23: case 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable account' })).toBeTruthy();
    expect(posts(fetch)).toEqual([
      [`/api/admin/ops/users/${ENCODED}/disable`, { reason: 'case 3' }],
    ]);
  });

  it('closes an account only once its ID is typed', async () => {
    const fetch = server({
      [`POST /api/admin/ops/users/${ENCODED}/close`]: () =>
        json({ ...USER, deletion: { requestedAt: '2026-10-23T10:00:00Z' } }),
    });
    renderAdmin(`/app/ops/users?sub=${ENCODED}`, { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Close account' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Close this account?' }));
    const confirm = dialog.getByRole('button', { name: 'Close account' }) as HTMLButtonElement;
    fireEvent.change(dialog.getByLabelText(/Type the account ID/), { target: { value: 'nope' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/Type the account ID/), { target: { value: SUB } });
    fireEvent.click(confirm);
    expect(await screen.findByText('Being deleted (asked 2026-10-23)')).toBeTruthy();
    expect(posts(fetch)).toEqual([[`/api/admin/ops/users/${ENCODED}/close`, { confirm: SUB }]]);
  });

  it('unpublishes after a confirm, hides at once, and restores from the trash', async () => {
    const fetch = server({
      [`POST /api/admin/ops/users/${ENCODED}/tours/t1`]: () => json(USER),
      [`POST /api/admin/ops/users/${ENCODED}/restore`]: () => json({ ...USER, trash: [] }),
    });
    renderAdmin(`/app/ops/users?sub=${ENCODED}`, { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Unpublish this tour?' }));
    expect(posts(fetch)).toEqual([]);
    fireEvent.click(dialog.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Hide from Explore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Nothing in the trash.')).toBeTruthy();
    expect(posts(fetch)).toEqual([
      [`/api/admin/ops/users/${ENCODED}/tours/t1`, { action: 'unpublish' }],
      [`/api/admin/ops/users/${ENCODED}/tours/t1`, { action: 'hide' }],
      [`/api/admin/ops/users/${ENCODED}/restore`, { date: '2026-10-22', panoId: 'p9' }],
    ]);
  });

  it('asks to sign in again when the server wants a recent sign-in', async () => {
    const fetch = server({
      [`POST /api/admin/ops/users/${ENCODED}/enable`]: () =>
        json({ error: 'reauthentication required' }, 403),
      [`GET /api/admin/ops/users/${ENCODED}`]: () =>
        json({ ...USER, disabled: { disabledAt: '2026-10-01T00:00:00Z' } }),
    });
    renderAdmin(`/app/ops/users?sub=${ENCODED}`, { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Enable account' }));
    expect(
      await screen.findByRole('dialog', { name: 'Sign in again to make changes' }),
    ).toBeTruthy();
  });

  it('says when the search fails, and when an ID holds nothing (with no Close)', async () => {
    const EMPTY = 'google-oauth2|typo';
    renderAdmin('/app/ops/users', {
      fetch: server({
        'GET /api/admin/ops/users/lookup': () => json({ error: 'boom' }, 500),
        [`GET /api/admin/ops/users/${encodeURIComponent(EMPTY)}`]: () =>
          json({
            ...USER,
            sub: EMPTY,
            since: null,
            usage: { panos: 0, bytes: 0, uploadsToday: 0, tours: 0 },
            tours: [],
            trash: [],
          }),
      }),
    });
    fireEvent.change(await screen.findByLabelText('Find an account'), {
      target: { value: 'old-town' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('Couldn’t search just now. Try again.')).toBeTruthy();
    cleanup();

    renderAdmin(`/app/ops/users?sub=${encodeURIComponent(EMPTY)}`, {
      fetch: server({
        [`GET /api/admin/ops/users/${encodeURIComponent(EMPTY)}`]: () =>
          json({
            ...USER,
            sub: EMPTY,
            since: null,
            usage: { panos: 0, bytes: 0, uploadsToday: 0, tours: 0 },
            tours: [],
            trash: [],
          }),
      }),
    });
    expect(await screen.findByText(/Panote holds nothing for this account ID/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close account' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disable account' })).toBeTruthy();
  });

  it('says so when the account fails to load, with a retry', async () => {
    let fail = true;
    renderAdmin(`/app/ops/users?sub=${ENCODED}`, {
      fetch: server({
        [`GET /api/admin/ops/users/${ENCODED}`]: () =>
          fail ? json({ error: 'boom' }, 500) : json(USER),
      }),
    });
    const alert = await screen.findByRole('alert');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Account' })).toBeTruthy();
  });
});

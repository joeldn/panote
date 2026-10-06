import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { InsightsOk } from '@internal/contracts';
import type { AdminApi, InsightsResult } from '@internal/web-kit';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, TEST_CONFIG } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { SessionContext } from '../session.js';
import { InsightsRoute } from './InsightsRoute.js';

const routes: RouteObject[] = [
  {
    path: 't/:tourId',
    element: <Outlet />,
    children: [
      { index: true, element: <p>Editor</p> },
      { path: 'insights', element: <InsightsRoute /> },
    ],
  },
];

const dates = Array.from({ length: 14 }, (_, i) => `2026-09-${String(18 + i).padStart(2, '0')}`)
  .slice(0, 13)
  .concat('2026-10-01');

const series = (views: number[]): InsightsOk['daily'] =>
  dates.map((date, i) => ({ date, views: views[i] ?? 0 }));

const INSIGHTS: InsightsOk = {
  days: 14,
  from: '2026-09-18T00:00:00.000Z',
  to: '2026-10-01T12:00:00.000Z',
  totalViews: 2,
  avgDwellMs: 134_000,
  daily: series([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]),
  byPano: [
    { panoId: 'pano-2', views: 2400 },
    { panoId: 'gone-1', views: 100 },
  ],
  topHotspots: [
    { panoId: 'pano-1', hotspotId: 'h1', opens: 2 },
    { panoId: 'pano-1', hotspotId: 'old', opens: 1 },
  ],
};

const EMPTY: InsightsOk = {
  ...INSIGHTS,
  totalViews: 0,
  avgDwellMs: null,
  daily: series([]),
  byPano: [],
  topHotspots: [],
};

const tourOk = {
  status: 'ok' as const,
  data: {
    etag: 'e1',
    tour: {
      tourId: 'tour-1',
      title: 'Old Town',
      scenes: [{ panoId: 'pano-1' }, { panoId: 'pano-2' }],
    },
    configs: {
      'pano-1': {
        etag: 'c1',
        config: {
          panoId: 'pano-1',
          title: 'Square',
          hotspots: [{ id: 'h1', type: 'info', yaw: 0, pitch: 0, title: 'Fountain' }],
        },
      },
      'pano-2': { etag: 'c2', config: { panoId: 'pano-2', title: 'Courtyard', hotspots: [] } },
    },
    publish: null,
  },
};

function fakeApi(getInsights: () => Promise<InsightsResult>): AdminApi {
  return {
    getTourWithConfigs: vi.fn(async () => tourOk),
    getInsights: vi.fn(getInsights),
  } as unknown as AdminApi;
}

const statsFetch = (views: number | null) =>
  vi.fn(async (url: string) =>
    views === null
      ? new Response('{"error":"boom"}', { status: 500 })
      : url.endsWith('/api/tours/tour-1/stats')
        ? new Response(JSON.stringify({ views, likes: 0 }), { status: 200 })
        : new Response('{}', { status: 404 }),
  );

function renderInsights(api: AdminApi, fetch = statsFetch(3), path = '/app/t/tour-1/insights') {
  const router = createMemoryRouter(routes, { basename: '/app', initialEntries: [path] });
  render(
    <ConfigContext value={TEST_CONFIG}>
      <AuthEnvContext
        value={{ auth: fakeAuth(), origins: LOCAL, assign: vi.fn(), apiBase: '', fetch }}
      >
        <SessionContext
          value={{
            user: { sub: 'u1' },
            api,
            upload: { presign: vi.fn() },
            requestSignIn: () => {},
            holdSignIn: () => {},
            signOut: async () => {},
          }}
        >
          <RouterProvider router={router} />
        </SessionContext>
      </AuthEnvContext>
    </ConfigContext>,
  );
  return { router, fetch };
}

const dialog = () => screen.findByRole('dialog', { name: 'Insights' });
const card = (label: string) => screen.getByText(label).parentElement!;

afterEach(cleanup);

describe('insights route', () => {
  it('renders the real series, with total views from the exact counter', async () => {
    const api = fakeApi(async () => ({ status: 'ok', data: INSIGHTS }));
    const { fetch } = renderInsights(api);
    const modal = await dialog();
    expect(await within(modal).findByText('Old Town · last 14 days')).toBeTruthy();
    expect(api.getInsights).toHaveBeenCalledWith('tour-1', 14);
    expect(fetch).toHaveBeenCalledWith('/api/tours/tour-1/stats', { method: 'GET' });
    // 3 from TourStats, not the sampled series' 2.
    expect(card('Total views').textContent).toBe('Total views3All time');
    expect(card('Avg. time').textContent).toBe('Avg. time2m 14sPer viewing session');
    expect(screen.getByText(/Approximate — based on sampled data/)).toBeTruthy();

    const bars = within(screen.getByRole('list', { name: 'Views per day' })).getAllByRole(
      'listitem',
    );
    expect(bars).toHaveLength(14);
    expect(bars[0]?.textContent).toBe('18 Sep: 0 views');
    expect(bars[13]?.textContent).toBe('1 Oct: 1 view');
    expect(bars[13]?.style.height).toBe('100%');
    expect(bars[0]?.style.height).toBe('0%');

    expect(screen.getByText('Courtyard').nextElementSibling?.textContent).toBe('2.4k views');
    expect(screen.getByText('Removed pano').nextElementSibling?.textContent).toBe('100 views');
    const list = screen.getByRole('heading', { name: 'Most-opened points' }).nextElementSibling!;
    const points = within(list as HTMLElement)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(points).toEqual(['1FountainSquare2 opens', '2Removed pointSquare1 open']);
  });

  it('shows empty sections, not invented numbers, for an empty series', async () => {
    renderInsights(
      fakeApi(async () => ({ status: 'ok', data: EMPTY })),
      statsFetch(0),
    );
    await dialog();
    expect(await screen.findByText('No views in the last 14 days.')).toBeTruthy();
    expect(screen.getByText('No pano views yet.')).toBeTruthy();
    expect(screen.getByText('No points opened yet.')).toBeTruthy();
    expect(card('Avg. time').textContent).toBe('Avg. time—Per viewing session');
    expect(card('Total views').textContent).toBe('Total views0All time');
    const bars = document.querySelectorAll('.ins__bar[data-empty]');
    expect(bars).toHaveLength(14);
  });

  it('shows "Insights unavailable" on a 502 and retries', async () => {
    const getInsights = vi
      .fn<() => Promise<InsightsResult>>()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'ok', data: INSIGHTS });
    renderInsights(fakeApi(getInsights));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Insights unavailable/);
    expect(card('Avg. time').textContent).toBe('Avg. timeUnavailablePer viewing session');
    expect(screen.queryByText('Views over time')).toBeNull();
    // The exact counter doesn't depend on Analytics Engine.
    expect(card('Total views').textContent).toBe('Total views3All time');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(await screen.findByText('Views over time')).toBeTruthy();
    expect(getInsights).toHaveBeenCalledTimes(2);
  });

  it('says so when the stats counter or the insights call fail', async () => {
    renderInsights(
      fakeApi(() => Promise.reject(new Error('network'))),
      statsFetch(null),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Couldn’t load insights/);
    expect(card('Total views').textContent).toBe('Total viewsUnavailableAll time');
  });

  it('reports a tour that no longer exists', async () => {
    renderInsights(fakeApi(async () => ({ status: 'not-found' })));
    expect((await screen.findByRole('alert')).textContent).toBe('This tour no longer exists.');
  });

  it('closes back to the editor, keeping the selected pano', async () => {
    const { router } = renderInsights(
      fakeApi(async () => ({ status: 'ok', data: INSIGHTS })),
      statsFetch(3),
      '/app/t/tour-1/insights?pano=pano-2',
    );
    await dialog();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })));
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    expect(router.state.location.search).toBe('?pano=pano-2');
    expect(screen.getByText('Editor')).toBeTruthy();
  });
});

import type { OpsMetrics } from '@internal/contracts';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';

const hours = (n: number, v: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({
    t: new Date(Date.UTC(2026, 9, 22, 11 + i)).toISOString(),
    v: v(i),
  }));

const METRICS: OpsMetrics = {
  range: '24h',
  from: '2026-10-22T11:00:00.000Z',
  to: '2026-10-23T10:20:00.000Z',
  health: {
    status: 'ok',
    data: {
      failing: [{ check: 'website /', failures: 3 }],
      announcedDown: ['website /'],
      lastAlertAt: '2026-10-23T09:00:00.000Z',
      dailyCron: {
        lastRunAt: '2026-10-23T03:17:00.000Z',
        lastOkAt: '2026-10-22T03:17:00.000Z',
        failed: ['trash'],
      },
      tileGc: null,
      cdnPurge: { lastFailure: null, pending: 2, pendingCapped: false, dead: 0, deadCapped: false },
      backup: {
        lastCompleteDate: '2026-10-22',
        lastCompleteDaysAgo: 3,
        hasRun: true,
        inProgress: { date: '2026-10-23', objects: 1234, runs: 1 },
      },
    },
  },
  workers: {
    status: 'ok',
    data: {
      scripts: [
        {
          script: 'panote-admin-api-dev',
          requests: 1000,
          errors: 5,
          subrequests: 40,
          cpuP50Ms: 1.5,
          cpuP99Ms: 9,
          byStatus: { success: 995, scriptThrewException: 5 },
        },
      ],
      series: hours(24, (i) => i).map(({ t, v }) => ({
        t,
        requests: v * 10,
        errors: v % 5 ? 0 : 1,
      })),
    },
  },
  storage: { status: 'unavailable', reason: 'GraphQL: unknown field "r2StorageAdaptiveGroups"' },
  queues: {
    status: 'ok',
    data: {
      queues: [
        {
          queueId: 'q1',
          name: 'pano-uploads-dev',
          backlogAvg: null,
          writes: 10,
          reads: 10,
          acked: 8,
          dlq: 2,
          failed: 0,
          lagMsAvg: 2000,
          retriesAvg: 0.5,
        },
      ],
    },
  },
  durableObjects: { status: 'ok', data: { requests: 70, errors: null, storedBytes: 4096 } },
  containers: {
    status: 'ok',
    data: {
      cpuSeconds: 42,
      maxMemoryBytes: 5e8,
      cpuUtilizationP95: 0.9,
      instances: 2,
      series: hours(24, () => 0).map(({ t }) => ({ t, cpuSeconds: 0 })),
    },
  },
  usage: {
    status: 'ok',
    data: {
      month: '2026-10',
      items: [
        {
          key: 'worker-requests',
          label: 'Worker requests',
          used: 9_000_000,
          reason: null,
          included: 10_000_000,
          unit: 'count',
          scope: 'account',
        },
        {
          key: 'container-cpu',
          label: 'Container CPU',
          used: null,
          reason: 'GraphQL: no access',
          included: 22_500,
          unit: 'seconds',
          scope: 'account',
        },
      ],
    },
  },
  product: {
    status: 'ok',
    data: {
      views: 40,
      scenes: 12,
      hotspots: 3,
      dwellAvgMs: 5250,
      series: hours(24, (i) => (i === 22 ? 40 : 0)).map(({ t, v }) => ({ t, views: v })),
      topTours: [
        { tourId: 'tour-1', views: 30, title: 'Old Town', slug: 'old-town' },
        { tourId: 'tour-gone', views: 10, title: null, slug: null },
      ],
      surfaces: [{ surface: 'page', views: 40 }],
    },
  },
  pipeline: {
    status: 'ok',
    data: {
      events: [
        { event: 'upload-url', detail: 'new', service: 'upload-api', n: 4, value: 8e7 },
        { event: 'tile-ok', detail: '', service: 'tiler-consumer', n: 4, value: 100_000 },
        { event: 'tile-dead', detail: '', service: 'tiler-consumer', n: 1, value: 0 },
        { event: 'tile-refused', detail: 'oversize', service: 'tiler-consumer', n: 2, value: 0 },
        { event: 'tour-published', detail: 'share', service: 'admin-api', n: 3, value: 0 },
        { event: 'tour-published', detail: 'save', service: 'admin-api', n: 7, value: 0 },
        { event: 'rate-limited', detail: 'WRITE_LIMITER', service: 'admin-api', n: 2, value: 0 },
        { event: 'client-error', detail: 'website', service: 'public-api', n: 6, value: 0 },
        {
          event: 'server-error',
          detail: '500 PUT /api/admin/tours/:tourId',
          service: 'admin-api',
          n: 3,
          value: 0,
        },
      ],
      tileP95Ms: 41_000,
      series: hours(24, (i) => (i === 22 ? 4 : 0)).map(({ t, v }) => ({
        t,
        uploads: v,
        tiled: v,
        failed: 0,
      })),
    },
  },
  moderation: {
    status: 'ok',
    data: {
      explore: {
        waiting: 2,
        changed: 1,
        oldest: [
          {
            tourId: 'tour-1',
            title: 'Old Town',
            slug: 'old-town',
            reason: 'changed',
            queuedAt: '2026-10-21T10:20:00.000Z',
          },
          {
            tourId: 'tour-2',
            title: '',
            slug: 'harbour',
            reason: 'new',
            queuedAt: '2026-10-23T09:40:00.000Z',
          },
        ],
      },
      flags: { viewer: 3, screening: 1, more: true, newestAt: '2026-10-23T09:00:00.000Z' },
    },
  },
  accounts: {
    status: 'ok',
    data: {
      partial: false,
      totals: {
        accounts: 2,
        panos: 3,
        originalBytes: 5 * 2 ** 20,
        tours: 3,
        shared: 2,
        public: 1,
        uploads24h: 2,
      },
      heaviest: [
        { sub: 'auth0|big', panos: 2, originalBytes: 4 * 2 ** 20, tours: 2, uploads24h: 0 },
        { sub: 'auth0|small', panos: 1, originalBytes: 2 ** 20, tours: 1, uploads24h: 2 },
      ],
      busiest: [{ sub: 'auth0|small', panos: 1, originalBytes: 2 ** 20, tours: 1, uploads24h: 2 }],
      recentlyPublished: [
        {
          tourId: 't1',
          sub: 'auth0|small',
          title: 'Harbour',
          slug: 'harbour',
          visibility: 'public',
          at: '2026-10-23T08:00:00.000Z',
        },
      ],
    },
  },
};

const server = (metrics: OpsMetrics | null) => {
  const ranges: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://x');
    if (url.pathname === '/api/admin/account') {
      return Response.json({ email: null, signIns: ['google-oauth2'], operator: true });
    }
    if (url.pathname === '/api/admin/ops/metrics') {
      const range = url.searchParams.get('range') ?? '';
      ranges.push(range);
      if (!metrics) return Response.json({ error: 'boom' }, { status: 500 });
      return Response.json({ ...metrics, range });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  return { fetch, ranges };
};

afterEach(cleanup);

const panel = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name}`) });

describe('the operator dashboard', () => {
  it('shows every section, and says why one is unavailable', async () => {
    renderAdmin('/app/ops', { fetch: server(METRICS).fetch });
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();

    const health = panel('Health');
    expect(within(health).getByText(/website \/ \(3× in a row\)/)).toBeTruthy();
    expect(within(health).getByText(/failed: trash/)).toBeTruthy();
    expect(within(health).getByText(/2 queued, 0 dead letters/)).toBeTruthy();
    const backup = within(health)
      .getByText(/Last complete set 2026-10-22/)
      .closest('li')!;
    expect(backup.className).toContain('opsd__status--bad');
    expect(within(backup).getByText('Failing')).toBeTruthy();
    expect(
      within(health).getByText(/2026-10-23 being written \(1,234 objects so far\)/),
    ).toBeTruthy();

    const pipeline = panel('Pipeline');
    expect(within(pipeline).getByText('25 s')).toBeTruthy();
    expect(within(pipeline).getByText('41 s')).toBeTruthy();
    expect(within(pipeline).getByText(/Tours shared: 3 · Republished on save: 7/)).toBeTruthy();
    expect(within(pipeline).getByText('oversize')).toBeTruthy();
    expect(within(pipeline).getByText('WRITE_LIMITER')).toBeTruthy();
    expect(within(pipeline).getByText('website')).toBeTruthy();
    expect(
      within(pipeline).getByRole('list', { name: 'Panoramas tiled per hour' }).children,
    ).toHaveLength(24);

    const viewers = panel('Viewers');
    expect(within(viewers).getByText('Old Town')).toBeTruthy();
    expect(within(viewers).getByText('tour-gone (not published)')).toBeTruthy();
    expect(within(viewers).getByText('5.3 s')).toBeTruthy();
    expect(
      within(viewers).getByRole('list', { name: 'Tour views per hour' }).children,
    ).toHaveLength(24);

    const workers = panel('Workers');
    expect(within(workers).getByText('panote-admin-api-dev')).toBeTruthy();
    expect(within(workers).getByText('5 (0.5%)')).toBeTruthy();
    expect(within(workers).getByText('scriptThrewException 5')).toBeTruthy();

    // The Workers tile counts exceptions; the 500s the code answers are their own panel.
    expect(within(workers).getAllByText('Exceptions').length).toBeGreaterThan(0);
    const errors = panel('Server errors');
    expect(within(errors).getByText('PUT /api/admin/tours/:tourId')).toBeTruthy();
    expect(within(errors).getByText('500')).toBeTruthy();

    const waiting = panel('Waiting for you');
    expect(within(waiting).getAllByText('2 d')).toHaveLength(2);
    expect(within(waiting).getByText('40 min')).toBeTruthy();
    expect(within(waiting).getAllByText('Changed since approved')).toHaveLength(2);
    expect(
      within(waiting).getByRole('link', { name: 'Untitled tour' }).getAttribute('href'),
    ).toMatch(/\/s\/harbour$/);
    expect(within(waiting).getByText('4+')).toBeTruthy();
    expect(
      within(waiting).getByRole('link', { name: 'Open the approval queue' }).getAttribute('href'),
    ).toBe('/app/ops/explore');

    const accounts = panel('Accounts and content');
    expect(within(accounts).getByText('2 (1)')).toBeTruthy();
    expect(
      within(accounts).getAllByRole('link', { name: 'auth0|small' })[0]!.getAttribute('href'),
    ).toBe('/app/ops/users?sub=auth0%7Csmall');
    expect(within(accounts).getByRole('link', { name: 'Harbour' })).toBeTruthy();

    expect(within(panel('Durable Objects')).getByText('—')).toBeTruthy();
    expect(within(panel('Storage')).getByText(/Unavailable: GraphQL: unknown field/)).toBeTruthy();
    expect(within(panel('Upload queue')).getByText('pano-uploads-dev')).toBeTruthy();
    expect(within(panel('This month')).getByText('9,000,000 of 10,000,000')).toBeTruthy();
    expect(within(panel('This month')).getByText('Unavailable: GraphQL: no access')).toBeTruthy();
  });

  it('switches the range and refreshes', async () => {
    const s = server(METRICS);
    renderAdmin('/app/ops', { fetch: s.fetch });
    await screen.findByRole('heading', { name: 'Health' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await screen.findByRole('heading', { name: 'Health' });
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByRole('heading', { name: 'Health' });
    expect(s.ranges).toEqual(['24h', '7d', '7d']);
  });

  it('says so when the metrics cannot be loaded', async () => {
    renderAdmin('/app/ops', { fetch: server(null).fetch });
    expect(await screen.findByText('Couldn’t load the metrics. Try Refresh.')).toBeTruthy();
  });
});

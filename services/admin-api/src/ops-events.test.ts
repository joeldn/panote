// The operator events admin-api writes (@internal/contracts ops-events.ts): one per owner
// action that changed something, one per rate-limit refusal, and never the owner's sub.
import {
  configKey,
  manifestKey,
  OPS_EVENTS_SCHEMA_VERSION,
  originalKey,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import worker from './index.js';

const SUB = 'auth0|ops-events';

beforeAll(() => {
  setTestJwtVerifier(async (t) => (t === 'good' ? { sub: SUB } : Promise.reject(new Error('bad'))));
});

const bearer = { Authorization: 'Bearer good' };

type Point = { indexes: string[]; blobs: string[]; doubles: number[] };

const sink = () => {
  const points: Point[] = [];
  return { points, writeDataPoint: vi.fn((p: Point) => void points.push(p)) };
};

const call = async (
  events: ReturnType<typeof sink>,
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {},
) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://x${path}`, { ...init, headers: { ...bearer, ...init.headers } }),
    { ...env, OPS_EVENTS: events, ...overrides } as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
};

const names = (events: ReturnType<typeof sink>) => events.points.map((p) => p.blobs[0]);

const readyPano = async (events: ReturnType<typeof sink>, panoId: string) => {
  await env.BUCKET.put(originalKey(SUB, panoId), 'bytes');
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId }));
  const r = await call(events, `/api/admin/panos/${panoId}/config`, {
    method: 'PUT',
    headers: { 'If-Match': '*' },
    body: JSON.stringify({ title: panoId, hotspots: [] }),
  });
  expect(r.status).toBe(200);
};

describe('operator events', () => {
  it('records a 500 by its route pattern, never the path', async () => {
    const events = sink();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.spyOn(env.BUCKET, 'list').mockRejectedValue(new Error('R2 down'));
    try {
      expect((await call(events, '/api/admin/tours')).status).toBe(500);
    } finally {
      list.mockRestore();
    }
    expect(events.points.map((p) => p.blobs.slice(0, 3))).toContainEqual([
      'server-error',
      '500 GET /api/admin/tours',
      'admin-api',
    ]);
  });

  it('records a tour created, shared, unshared and deleted', async () => {
    const events = sink();
    await readyPano(events, 'ops-ev-p1');
    const created = await call(events, '/api/admin/tours', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ops events', scenes: [{ panoId: 'ops-ev-p1' }] }),
    });
    expect(created.status).toBe(201);
    const { tourId } = (await created.json()) as { tourId: string };

    const shared = await call(events, `/api/admin/tours/${tourId}/publish`, {
      method: 'POST',
      body: '{}',
    });
    expect(shared.status).toBe(200);
    const unshared = await call(events, `/api/admin/tours/${tourId}/publish`, {
      method: 'DELETE',
    });
    expect(unshared.status).toBe(204);
    const deleted = await call(events, `/api/admin/tours/${tourId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    expect(names(events)).toEqual([
      'tour-created',
      'tour-published',
      'tour-unpublished',
      'tour-deleted',
    ]);
    const published = events.points[1]!;
    expect(published.blobs).toEqual([
      'tour-published',
      'share',
      'admin-api',
      OPS_EVENTS_SCHEMA_VERSION,
    ]);
    expect(published.indexes).toEqual(['tour-published']);
    // What happened, never who or which tour.
    const all = JSON.stringify(events.points);
    expect(all).not.toContain(SUB);
    expect(all).not.toContain(tourId);
  });

  it('records nothing for a refused write', async () => {
    const events = sink();
    const r = await call(events, '/api/admin/tours', { method: 'POST', body: '{nope' });
    expect(r.status).toBe(400);
    expect(events.points).toEqual([]);
  });

  it('records a pano delete', async () => {
    const events = sink();
    // A config alone: no original, so no "still processing" refusal.
    await env.BUCKET.put(
      configKey(SUB, 'ops-ev-del'),
      JSON.stringify({ panoId: 'ops-ev-del', title: 'x', hotspots: [] }),
    );
    const r = await call(events, '/api/admin/panos/ops-ev-del', { method: 'DELETE' });
    expect(r.status).toBe(204);
    expect(names(events)).toEqual(['pano-deleted']);
  });

  it.each([
    ['READ_LIMITER', '/api/admin/tours', {}],
    ['WRITE_LIMITER', '/api/admin/tours', { method: 'POST', body: '{}' }],
  ] as const)('records a %s refusal as rate-limited', async (limiter, path, init) => {
    const events = sink();
    const refuse = { limit: vi.fn(async () => ({ success: false })) };
    const r = await call(events, path, init, { [limiter]: refuse });
    expect(r.status).toBe(429);
    expect(events.points).toEqual([
      {
        indexes: ['rate-limited'],
        blobs: ['rate-limited', limiter, 'admin-api', OPS_EVENTS_SCHEMA_VERSION],
        doubles: [0],
      },
    ]);
  });

  it('serves the request when the event write throws', async () => {
    const broken = {
      points: [],
      writeDataPoint: vi.fn(() => {
        throw new Error('down');
      }),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await call(broken, '/api/admin/tours', {
      method: 'POST',
      body: JSON.stringify({ title: 'Still works', scenes: [] }),
    });
    expect(r.status).toBe(201);
    expect(broken.writeDataPoint).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

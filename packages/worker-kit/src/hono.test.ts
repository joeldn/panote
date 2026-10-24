import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';

import { errorHandler, recordServerErrors } from './hono.js';
import { PreconditionRequiredError, UnauthorizedError } from './errors.js';

const appWithRoute = (handler: () => never): Hono => {
  const app = new Hono();
  app.get('/', handler);
  app.onError(errorHandler);
  return app;
};

describe('errorHandler', () => {
  it('maps a thrown UnauthorizedError to 401 JSON', async () => {
    const app = appWithRoute(() => {
      throw new UnauthorizedError();
    });
    const res = await app.request('/');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('maps a thrown PreconditionRequiredError to 428 JSON', async () => {
    const app = appWithRoute(() => {
      throw new PreconditionRequiredError();
    });
    const res = await app.request('/');
    expect(res.status).toBe(428);
    await expect(res.json()).resolves.toEqual({ error: 'If-Match required for update' });
  });

  it('maps a thrown plain Error to 500 JSON', async () => {
    const app = appWithRoute(() => {
      throw new Error('boom');
    });
    const res = await app.request('/');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal' });
  });

  it('logs the error with the owner segment of an R2 key masked', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWithRoute(() => {
      throw new Error('R2 GET tours/Z29vZ2xl/t1/tour.json -> 500');
    });
    await app.request('/');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]![1]);
    expect(logged).toContain('Error: R2 GET tours/<owner>/t1/tour.json -> 500');
    expect(logged).not.toContain('Z29vZ2xl');
  });

  it('logs the redacted cause chain', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWithRoute(() => {
      throw new Error('publish failed', { cause: new Error('R2 PUT tours/Z29vZ2xl/t1/x -> 500') });
    });
    await app.request('/');
    const logged = String(errorSpy.mock.calls[0]![1]);
    expect(logged).toContain('caused by: Error: R2 PUT tours/<owner>/t1/x -> 500');
    expect(logged).not.toContain('Z29vZ2xl');
  });

  it("lets Hono's own HTTPException pass through unchanged", async () => {
    const app = appWithRoute(() => {
      throw new HTTPException(418, { message: 'teapot' });
    });
    const res = await app.request('/');
    expect(res.status).toBe(418);
    await expect(res.text()).resolves.toBe('teapot');
  });
});

describe('recordServerErrors', () => {
  const sink = () => ({ writeDataPoint: vi.fn() });
  const app = () => {
    const sub = new Hono();
    sub.get('/:tourId', (c) => c.json({ error: 'upstream' }, 502));
    const a = new Hono<{ Bindings: { OPS_EVENTS?: ReturnType<typeof sink> } }>();
    a.use('*', recordServerErrors('test-api'));
    a.get('/api/things/:thingId', () => {
      throw new Error('boom');
    });
    a.get('/api/ok/:id', (c) => c.json({ ok: true }));
    a.get('/api/missing', () => {
      throw new UnauthorizedError();
    });
    a.route('/api/tours', sub);
    a.onError(errorHandler);
    return a;
  };
  it('records a thrown 500 by its route pattern, never the ids in the path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = sink();
    const res = await app().request('/api/things/secret-id-1', {}, { OPS_EVENTS: s });
    expect(res.status).toBe(500);
    expect(s.writeDataPoint).toHaveBeenCalledTimes(1);
    const blobs = s.writeDataPoint.mock.calls[0]![0].blobs as string[];
    expect(blobs.slice(0, 3)).toEqual(['server-error', '500 GET /api/things/:thingId', 'test-api']);
    expect(JSON.stringify(s.writeDataPoint.mock.calls)).not.toContain('secret-id-1');
  });

  it('records a 5xx a mounted route returns', async () => {
    const s = sink();
    await app().request('/api/tours/tour-9', {}, { OPS_EVENTS: s });
    const blobs = s.writeDataPoint.mock.calls[0]![0].blobs as string[];
    expect(blobs[1]).toBe('502 GET /api/tours/:tourId');
  });

  it('records nothing below 500, and runs without a binding', async () => {
    const s = sink();
    expect((await app().request('/api/ok/1', {}, { OPS_EVENTS: s })).status).toBe(200);
    expect((await app().request('/api/missing', {}, { OPS_EVENTS: s })).status).toBe(401);
    expect((await app().request('/nowhere', {}, { OPS_EVENTS: s })).status).toBe(404);
    expect(s.writeDataPoint).not.toHaveBeenCalled();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await app().request('/api/things/x', {}, {})).status).toBe(500);
  });
});

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';

import { errorHandler } from './hono.js';
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

  it("lets Hono's own HTTPException pass through unchanged", async () => {
    const app = appWithRoute(() => {
      throw new HTTPException(418, { message: 'teapot' });
    });
    const res = await app.request('/');
    expect(res.status).toBe(418);
    await expect(res.text()).resolves.toBe('teapot');
  });
});

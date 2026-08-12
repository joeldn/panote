import { describe, expect, it } from 'vitest';

import { PreconditionRequiredError, toErrorResponse, UnauthorizedError } from './errors.js';

describe('UnauthorizedError', () => {
  it('has status 401 and message "unauthorized"', () => {
    const err = new UnauthorizedError();
    expect(err.status).toBe(401);
    expect(err.message).toBe('unauthorized');
  });
});

describe('PreconditionRequiredError', () => {
  it('has status 428', () => {
    expect(new PreconditionRequiredError().status).toBe(428);
  });
});

describe('toErrorResponse', () => {
  it('maps a WorkerError to its status and message as JSON', async () => {
    const res = toErrorResponse(new UnauthorizedError());
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('maps a plain Error to 500 without leaking its message', async () => {
    const res = toErrorResponse(new Error('boom'));
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    expect(body).toEqual({ error: 'internal' });
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('maps a non-Error throw to 500', async () => {
    const res = toErrorResponse('a string');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal' });
  });
});

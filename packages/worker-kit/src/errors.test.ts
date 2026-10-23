import { describe, expect, it, vi } from 'vitest';

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

  it('logs on the 500 path (an unrecognised throw), without changing the response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = toErrorResponse(new Error('missing R2 secret'));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal' });
  });

  it('masks the owner segment of an R2 key in the logged message', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toErrorResponse(
      new Error('R2 PUT upload-log/Z29vZ2xl/x -> 500; HEAD panos/Z29vZ2xl/p1/original'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'internal error:',
      'R2 PUT upload-log/<owner>/x -> 500; HEAD panos/<owner>/p1/original',
    );
    toErrorResponse('tours/Z29vZ2xl/t1/tour.json');
    expect(errorSpy).toHaveBeenLastCalledWith('internal error:', 'tours/<owner>/t1/tour.json');
  });

  it('does not log for an expected 4xx WorkerError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toErrorResponse(new UnauthorizedError());
    toErrorResponse(new PreconditionRequiredError());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

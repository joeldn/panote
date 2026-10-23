import { describe, expect, it, vi } from 'vitest';

import {
  describeError,
  PreconditionRequiredError,
  toErrorResponse,
  UnauthorizedError,
} from './errors.js';

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

  it('logs message and stack with the owner segment of an R2 key masked', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toErrorResponse(
      new Error('R2 PUT upload-log/Z29vZ2xl/x -> 500; HEAD panos/Z29vZ2xl/p1/original'),
    );
    const logged = String(errorSpy.mock.calls[0]![1]);
    expect(errorSpy.mock.calls[0]![0]).toBe('internal error:');
    expect(logged).toMatch(
      /^Error: R2 PUT upload-log\/<owner>\/x -> 500; HEAD panos\/<owner>\/p1\/original\n\s+at /,
    );
    expect(logged).not.toContain('Z29vZ2xl');
    toErrorResponse('tours/Z29vZ2xl/t1/tour.json');
    expect(errorSpy).toHaveBeenLastCalledWith('internal error:', 'tours/<owner>/t1/tour.json');
  });

  it('logs the cause chain, redacted too', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inner = new Error('R2 GET accounts/Z29vZ2xl/deletion.json -> 503');
    toErrorResponse(new Error('delete failed', { cause: inner }));
    const logged = String(errorSpy.mock.calls[0]![1]);
    expect(logged).toContain('Error: delete failed');
    expect(logged).toContain('caused by: Error: R2 GET accounts/<owner>/deletion.json -> 503');
    expect(logged).not.toContain('Z29vZ2xl');
  });

  it('does not log for an expected 4xx WorkerError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toErrorResponse(new UnauthorizedError());
    toErrorResponse(new PreconditionRequiredError());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('describeError', () => {
  it('stops at a cyclic cause and stringifies a non-Error cause', () => {
    const e = new Error('loop');
    e.cause = e;
    expect(describeError(e).match(/caused by:/g)).toHaveLength(5);
    expect(describeError(new Error('x', { cause: 'panos/Z29v/p1' }))).toContain(
      'caused by: panos/<owner>/p1',
    );
  });

  it('logs a thrown plain object as redacted JSON, and survives a cycle', () => {
    expect(describeError({ code: 'R2', key: 'panos/Z29v/p1/original' })).toBe(
      '{"code":"R2","key":"panos/<owner>/p1/original"}',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeError(cyclic)).toBe('[object Object]');
  });
});

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import app, { RATE_PERIOD_SECONDS } from './index.js';

const REPORT = {
  app: 'website',
  release: 'BxR2v9Qe',
  kind: 'error',
  message: 'TypeError: boom',
  stack: ['at f (https://panote.dev/assets/index-BxR2v9Qe.js:1:2)'],
  path: '/s/:slug',
};

let ipSeq = 0;
const post = (body: string) =>
  SELF.fetch('https://x/api/errors', {
    method: 'POST',
    // Its own client IP per request, so the real limiter never trips here.
    headers: { 'CF-Connecting-IP': `192.0.2.${++ipSeq}` },
    body,
  });

describe('POST /api/errors', () => {
  it('logs one structured line and answers 204', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await post(JSON.stringify(REPORT));
    expect(r.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: 'client-error', ...REPORT });
  });

  it('scrubs a hand-made report again before logging it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await post(
      JSON.stringify({
        ...REPORT,
        message: 'for me@example.com at https://panote.dev/x?token=t',
        stack: ['at f (https://panote.dev/a.js?sig=s:1:2)'],
        path: '/s/secret-slug',
      }),
    );
    expect(r.status).toBe(204);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'for <email> at https://panote.dev/x',
        stack: ['at f (https://panote.dev/a.js:1:2)'],
        path: '/s/:slug',
      }),
    );
  });

  it('logs only the report fields, never extra keys', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await post(JSON.stringify({ ...REPORT, email: 'me@example.com', url: 'https://x/?a=1' }));
    expect(Object.keys(log.mock.calls[0]![0] as object).sort()).toEqual(
      ['app', 'event', 'kind', 'message', 'path', 'release', 'stack'].sort(),
    );
  });

  it.each([
    ['not JSON', '{'],
    ['an empty body', ''],
    ['a full URL as the path', JSON.stringify({ ...REPORT, path: 'https://panote.dev/?q=1' })],
    ['an unknown app', JSON.stringify({ ...REPORT, app: 'other' })],
  ])('400s %s without logging', async (_label, body) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it('413s a body over the beacon size cap', async () => {
    const r = await post(JSON.stringify({ ...REPORT, message: 'x'.repeat(9000) }));
    expect(r.status).toBe(413);
  });

  it('429s with Retry-After, keyed by client IP, on its own limiter only', async () => {
    const limit = vi.fn(async (_o: { key: string }) => ({ success: false }));
    const other = vi.fn(async (_o: { key: string }) => ({ success: true }));
    const r = await app.request(
      '/api/errors',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '2001:db8:1:2::9' },
        body: JSON.stringify(REPORT),
      },
      {
        ...env,
        ERRORS_LIMITER: { limit },
        VIEW_LIMITER: { limit: other },
        LIKE_LIMITER: { limit: other },
        EVENTS_LIMITER: { limit: other },
      },
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(RATE_PERIOD_SECONDS));
    expect(limit).toHaveBeenCalledWith({ key: '2001:db8:1:2::/64' });
    expect(other).not.toHaveBeenCalled();
  });
});

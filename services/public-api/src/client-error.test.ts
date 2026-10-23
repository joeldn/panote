import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import {
  OPS_EVENTS_SCHEMA_VERSION,
  MAX_ERROR_FRAME_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_PATH_LENGTH,
} from '@internal/contracts';

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
const post = (body: string, headers: Record<string, string> = {}) =>
  SELF.fetch('https://x/api/errors', {
    method: 'POST',
    // Its own client IP per request, so the real limiter never trips here.
    headers: { 'CF-Connecting-IP': `192.0.2.${++ipSeq}`, ...headers },
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

  it('caps each field again after the scrub, which can lengthen it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // `a@b.co ` is 7 chars and becomes `<email> `, 8: 300 chars scrub to ~343.
    const emails = (max: number) => 'a@b.co '.repeat(Math.floor(max / 7)).slice(0, max);
    const r = await post(
      JSON.stringify({
        ...REPORT,
        message: emails(MAX_ERROR_MESSAGE_LENGTH),
        stack: [emails(MAX_ERROR_FRAME_LENGTH)],
        path: '/a@b.co'.repeat(Math.floor(MAX_ERROR_PATH_LENGTH / 7)),
      }),
    );
    expect(r.status).toBe(204);
    const logged = log.mock.calls[0]![0] as { message: string; stack: string[]; path: string };
    expect(logged.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(logged.message.startsWith('<email> <email>')).toBe(true);
    expect(logged.stack[0]).toHaveLength(MAX_ERROR_FRAME_LENGTH);
    expect(logged.path).toHaveLength(MAX_ERROR_PATH_LENGTH);
  });

  it.each([
    ['a cross-site Sec-Fetch-Site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['a same-site (other subdomain) Sec-Fetch-Site', { 'Sec-Fetch-Site': 'same-site' }],
    ['a user-initiated Sec-Fetch-Site', { 'Sec-Fetch-Site': 'none' }],
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    [
      'a same-origin Sec-Fetch-Site with a foreign Origin',
      {
        'Sec-Fetch-Site': 'same-origin',
        Origin: 'https://evil.example',
      },
    ],
  ])('403s %s without logging', async (_label, headers) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await post(JSON.stringify(REPORT), headers);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'cross-origin' });
    expect(log).not.toHaveBeenCalled();
  });

  it('takes a same-origin browser report and a client that sends neither header', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const same = await post(JSON.stringify(REPORT), {
      'Sec-Fetch-Site': 'same-origin',
      Origin: 'https://x',
    });
    expect(same.status).toBe(204);
    expect((await post(JSON.stringify(REPORT))).status).toBe(204);
  });

  it('refuses a cross-site report before it costs a limiter call', async () => {
    const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
    const r = await app.request(
      '/api/errors',
      { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify(REPORT) },
      { ...env, ERRORS_LIMITER: { limit } },
    );
    expect(r.status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
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

  describe('operator events', () => {
    const sink = () => ({ writeDataPoint: vi.fn() });

    it('counts an accepted report by app, with nothing else from it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const events = sink();
      const r = await app.request(
        '/api/errors',
        { method: 'POST', body: JSON.stringify(REPORT) },
        { ...env, OPS_EVENTS: events },
      );
      expect(r.status).toBe(204);
      expect(events.writeDataPoint).toHaveBeenCalledExactlyOnceWith({
        indexes: ['client-error'],
        blobs: ['client-error', 'website', 'public-api', OPS_EVENTS_SCHEMA_VERSION],
        doubles: [0],
      });
    });

    it('records nothing for a refused report', async () => {
      const events = sink();
      const r = await app.request(
        '/api/errors',
        { method: 'POST', body: '{' },
        { ...env, OPS_EVENTS: events },
      );
      expect(r.status).toBe(400);
      expect(events.writeDataPoint).not.toHaveBeenCalled();
    });

    it('records a limiter refusal by limiter name', async () => {
      const events = sink();
      const r = await app.request(
        '/api/errors',
        { method: 'POST', body: JSON.stringify(REPORT) },
        { ...env, OPS_EVENTS: events, ERRORS_LIMITER: { limit: async () => ({ success: false }) } },
      );
      expect(r.status).toBe(429);
      expect(events.writeDataPoint).toHaveBeenCalledExactlyOnceWith({
        indexes: ['rate-limited'],
        blobs: ['rate-limited', 'ERRORS_LIMITER', 'public-api', OPS_EVENTS_SCHEMA_VERSION],
        doubles: [0],
      });
    });
  });
});

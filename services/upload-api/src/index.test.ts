// services/upload-api/src/index.test.ts
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  setTestJwtVerifier(async (t: string) => {
    // `throw` rather than `return Promise.reject(...)`: the latter constructs an
    // already-rejected promise before it is returned/awaited, and workerd flags
    // it as an unhandled rejection even though `authenticate`'s try/catch does
    // handle it a tick later.
    if (t !== 'good') throw new Error('bad');
    return { sub: 'auth0|me' };
  });
});

describe('upload-url', () => {
  it('401 without token', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', { method: 'POST' });
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });

  it('401 with a bad token (seam rejects it)', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad' },
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns a presigned PUT url scoped to the user', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', {
      method: 'POST',
      headers: { Authorization: 'Bearer good' },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { panoId: string; key: string; url: string };
    expect(j.key).toMatch(/^panos\/auth0%7Cme\/[0-9a-f-]+\/original$/);
    expect(j.url).toContain('X-Amz-Signature=');
  });

  it('presigns with the default 15-minute expiry', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', {
      method: 'POST',
      headers: { Authorization: 'Bearer good' },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string };
    expect(j.url).toContain('X-Amz-Expires=900');
  });

  it('404 for GET /api/upload-url', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', { method: 'GET' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });

  it('404 for POST /api/nope', async () => {
    const r = await SELF.fetch('https://x/api/nope', { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });
});

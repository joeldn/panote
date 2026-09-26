// services/upload-api/src/index.test.ts
import { deletingKey, encodeId, originalKey } from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, it, expect, beforeAll, vi, type Mock } from 'vitest';

// Maps a HEAD's target key suffix to a canned status, so a single mock can
// drive both the original and tombstone HEADs independently per test.
const mockHeads = (statuses: { original: number; tombstone: number }): Mock =>
  vi.fn(async (input: Request | string) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    const status = reqUrl.endsWith('/deleting') ? statuses.tombstone : statuses.original;
    return new Response(null, { status });
  });

const validBody = { contentType: 'image/jpeg', size: 1024 };

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

const post = (body?: unknown) =>
  SELF.fetch('https://x/api/upload-url', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    const r = await post(validBody);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { panoId: string; key: string; url: string };
    // The owner segment is base64url-encoded; panoId is stored raw
    // (packages/contracts/src/keys.ts).
    expect(j.key).toBe(`panos/${encodeId('auth0|me')}/${j.panoId}/original`);
    expect(j.key).toMatch(/^panos\/[A-Za-z0-9_-]+\/[0-9a-f-]+\/original$/);
    expect(j.url).toContain('X-Amz-Signature=');
  });

  it('presigns with the default 15-minute expiry', async () => {
    const r = await post(validBody);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string };
    expect(j.url).toContain('X-Amz-Expires=900');
  });

  it('pins the content-type into the signed URL', async () => {
    const r = await post({ contentType: 'image/webp', size: 1024 });
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
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

  describe('content-type validation', () => {
    it('400 when contentType is missing', async () => {
      const r = await post({ size: 1024 });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: expect.stringContaining('image/jpeg') });
    });

    it('400 for a non-image content-type', async () => {
      const r = await post({ contentType: 'text/plain', size: 1024 });
      expect(r.status).toBe(400);
    });

    it('400 for a near-miss image content-type', async () => {
      const r = await post({ contentType: 'image/jpg', size: 1024 });
      expect(r.status).toBe(400);
    });
  });

  describe('size validation', () => {
    const MAX = 150 * 1024 * 1024;

    it('accepts exactly 150 MiB', async () => {
      const r = await post({ contentType: 'image/png', size: MAX });
      expect(r.status).toBe(200);
    });

    it('400 for one byte over 150 MiB', async () => {
      const r = await post({ contentType: 'image/png', size: MAX + 1 });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: expect.stringContaining('150') });
    });

    it('400 when size is missing', async () => {
      const r = await post({ contentType: 'image/png' });
      expect(r.status).toBe(400);
    });

    it('400 for a non-positive size', async () => {
      const r = await post({ contentType: 'image/png', size: 0 });
      expect(r.status).toBe(400);
    });

    it('400 for a non-numeric size', async () => {
      const r = await post({ contentType: 'image/png', size: '1024' });
      expect(r.status).toBe(400);
    });

    it('400 for a non-integer size', async () => {
      const r = await post({ contentType: 'image/png', size: 1.5 });
      expect(r.status).toBe(400);
    });
  });

  describe('replace image (panoId given)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('400 when panoId does not match PANO_PATTERN', async () => {
      const r = await post({ ...validBody, panoId: 'not/a/valid/id' });
      expect(r.status).toBe(400);
    });

    it.each([123, null, '', ['p1'], {}])(
      '400 for a non-string/empty panoId (%j), rather than silently minting a new pano',
      async (panoId) => {
        const r = await post({ ...validBody, panoId });
        expect(r.status).toBe(400);
      },
    );

    it('404 when the caller has no original at that panoId', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 404 })),
      );
      const r = await post({ ...validBody, panoId: 'missing-pano' });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'original not found' });
    });

    it('404 while a delete tombstone exists, even if the original still HEADs ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 200 })),
      );
      const r = await post({ ...validBody, panoId: 'being-deleted' });
      expect(r.status).toBe(404);
    });

    it('re-presigns the same key, scoped to the caller, when the original exists and is not tombstoned', async () => {
      const owner = encodeId('auth0|me');
      const fetchMock = vi.fn(async (input: Request | string) => {
        const reqUrl = typeof input === 'string' ? input : input.url;
        // Only the caller's own tombstone key HEADs as missing; everything
        // else (the original) HEADs ok - proves the check is owner-scoped.
        if (reqUrl.includes('/deleting')) return new Response(null, { status: 404 });
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const r = await post({ ...validBody, panoId: 'existing-pano' });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { panoId: string; key: string; url: string };
      expect(j.panoId).toBe('existing-pano');
      expect(j.key).toBe(originalKey('auth0|me', 'existing-pano'));
      expect(j.url).toContain(`${owner}/existing-pano/original`);

      const headUrls = fetchMock.mock.calls.map(([req]) =>
        typeof req === 'string' ? req : (req as Request).url,
      );
      expect(headUrls.some((u) => u.includes(originalKey('auth0|me', 'existing-pano')))).toBe(true);
      expect(headUrls.some((u) => u.includes(deletingKey('auth0|me', 'existing-pano')))).toBe(true);
    });

    it.each([500, 502, 403])(
      'fails closed with 502 (not 404) when the original HEAD errors with %i',
      async (status) => {
        vi.stubGlobal('fetch', mockHeads({ original: status, tombstone: 404 }));
        const r = await post({ ...validBody, panoId: 'flaky-original' });
        expect(r.status).toBe(502);
      },
    );

    it.each([500, 502, 403])(
      'fails closed with 502 (not "no tombstone") when the tombstone HEAD errors with %i',
      async (status) => {
        vi.stubGlobal('fetch', mockHeads({ original: 200, tombstone: status }));
        const r = await post({ ...validBody, panoId: 'flaky-tombstone' });
        expect(r.status).toBe(502);
      },
    );

    it("a persistent 5xx on the original HEAD surfaces as 502 quickly, not after aws4fetch's full retry budget", async () => {
      const fetchMock = mockHeads({ original: 500, tombstone: 404 });
      vi.stubGlobal('fetch', fetchMock);
      const r = await post({ ...validBody, panoId: 'persistently-flaky' });
      expect(r.status).toBe(502);
      // 1 initial + a small configured retry count, not 1 + aws4fetch's default of 10.
      expect((fetchMock as Mock).mock.calls.length).toBeLessThan(6);
    });
  });
});

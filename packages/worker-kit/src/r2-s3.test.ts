import { afterEach, describe, expect, it, vi } from 'vitest';

import { createR2S3Client } from './r2-s3.js';

const config = {
  accountId: 'acct123',
  bucket: 'mybucket',
  accessKeyId: 'test-access-key-id',
  secretAccessKey: 'test-secret-access-key',
};

describe('presignPut', () => {
  it('returns a URL containing X-Amz-Signature= and X-Amz-Expires=900 by default', async () => {
    const client = createR2S3Client(config);
    const url = await client.presignPut('panos/p1/config.json');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=900');
  });

  it('honours an explicit expiresInSeconds', async () => {
    const client = createR2S3Client(config);
    const url = await client.presignPut('panos/p1/config.json', { expiresInSeconds: 60 });
    expect(url).toContain('X-Amz-Expires=60');
  });

  it('signs the accountId/bucket/key endpoint, pinning the key-encoding behaviour', async () => {
    // `|` isn't in the WHATWG URL path percent-encode set, and aws4fetch
    // only re-encodes the path for the signature, never on the returned
    // Request.url - so a key containing `|` comes back literal, not `%7C`.
    // This client never encodes a key; keys.ts is responsible for keeping
    // keys URL-safe.
    const client = createR2S3Client(config);
    const url = await client.presignPut('panos/p|1/config.json');
    expect(
      url.startsWith('https://acct123.r2.cloudflarestorage.com/mybucket/panos/p|1/config.json?'),
    ).toBe(true);
  });

  it('pins content-type into SignedHeaders when opts.headers is given', async () => {
    // aws4fetch treats content-type as unsignable by default (it's meant for
    // streamed uploads with no known type yet), so pinning it needs allHeaders.
    const client = createR2S3Client(config);
    const url = await client.presignPut('panos/p1/original', {
      headers: { 'content-type': 'image/png' },
    });
    const signedHeaders = new URL(url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toBe('content-type;host');
  });

  it('omits content-type from SignedHeaders when no headers are given', async () => {
    const client = createR2S3Client(config);
    const url = await client.presignPut('panos/p1/original');
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('changes the signature when the pinned content-type changes, proving it is covered', async () => {
    const client = createR2S3Client(config);
    const pngUrl = await client.presignPut('panos/p1/original', {
      headers: { 'content-type': 'image/png' },
    });
    const jpegUrl = await client.presignPut('panos/p1/original', {
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(new URL(pngUrl).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(jpegUrl).searchParams.get('X-Amz-Signature'),
    );
  });
});

describe('put', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends content-type and, when given, cache-control', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    await client.put('panos/p1/config.json', '{}', {
      contentType: 'application/json',
      cacheControl: 'public, max-age=30',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('cache-control')).toBe('public, max-age=30');
  });

  it('throws when the response is not ok, naming the key and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const client = createR2S3Client(config);

    await expect(
      client.put('panos/p1/config.json', '{}', { contentType: 'application/json' }),
    ).rejects.toThrow('R2 PUT panos/p1/config.json -> 403');
  });
});

describe('get', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the Response unmodified, without throwing, on a 404', async () => {
    const notFound = new Response('missing', { status: 404 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => notFound),
    );
    const client = createR2S3Client(config);

    const res = await client.get('panos/missing/config.json');
    expect(res.status).toBe(404);
    expect(res).toBe(notFound);
  });
});

describe('head', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a HEAD request and returns ok/status/etag on success', async () => {
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(null, { status: 200, headers: { etag: '"abc123"' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    const result = await client.head('panos/u/p1/original');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.method).toBe('HEAD');
    expect(result).toEqual({ ok: true, status: 200, etag: '"abc123"' });
  });

  it('returns ok: false and etag: null on a 404, without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const client = createR2S3Client(config);

    const result = await client.head('panos/missing/original');
    expect(result).toEqual({ ok: false, status: 404, etag: null });
  });

  it('returns ok: false and the real status on a 500, without swallowing it as a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    // retries: 2 - aws4fetch's own default of 10 retries an all-500 mock for
    // ~30s of real backoff, which is exactly the bug this test guards against.
    const client = createR2S3Client({ ...config, retries: 2 });

    const result = await client.head('panos/p1/original');
    expect(result).toEqual({ ok: false, status: 500, etag: null });
  });

  it("honours a small configured `retries`, instead of aws4fetch's 10-retry default, so a persistent 5xx surfaces quickly", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client({ ...config, retries: 2 });

    await client.head('panos/p1/original');

    // 1 initial attempt + 2 retries, not aws4fetch's default of 1 + 10.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('deleteObject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a signed DELETE request for the key', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    await client.deleteObject('tiles/p1/t1-abc/0/px/0-0.webp');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.method).toBe('DELETE');
    expect(request?.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/mybucket/tiles/p1/t1-abc/0/px/0-0.webp',
    );
  });

  it('throws when the response is not ok, naming the key and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const client = createR2S3Client(config);

    await expect(client.deleteObject('tiles/p1/t1-abc/0/px/0-0.webp')).rejects.toThrow(
      'R2 DELETE tiles/p1/t1-abc/0/px/0-0.webp -> 403',
    );
  });
});

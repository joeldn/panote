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
    // Deviation from the port spec's stated expectation, verified empirically
    // against aws4fetch 1.0.20 + Node 24's URL/Request: the endpoint template is
    // a plain string substitution (`${base}/${key}`, no encodeURIComponent), and
    // neither `new URL(...)` nor the `Request` built from it percent-encodes `|`
    // in a path - `|` is not in the WHATWG URL path percent-encode set, and
    // aws4fetch only re-encodes the path internally for the *signature*
    // computation, never on the `Request.url` it returns. So a key containing
    // `|` comes back with a literal, unencoded `|`, not `%7C`. Pinning the real,
    // observed behaviour here rather than the spec's assumed one.
    const client = createR2S3Client(config);
    const url = await client.presignPut('panos/p|1/config.json');
    expect(
      url.startsWith('https://acct123.r2.cloudflarestorage.com/mybucket/panos/p|1/config.json?'),
    ).toBe(true);
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

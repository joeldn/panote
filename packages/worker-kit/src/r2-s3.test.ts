import { afterEach, describe, expect, it, vi } from 'vitest';

import { createR2S3Client, R2PreconditionFailedError } from './r2-s3.js';

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

// An independent SigV4 query-presign verifier (not aws4fetch): rebuilds the
// canonical request from the URL plus the headers a PUT would carry, and
// reports whether the URL's signature covers them. Plain keys only (no
// characters that need path encoding).
const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hmac = async (key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
};
const signatureCovers = async (
  presigned: string,
  method: string,
  sent: Record<string, string>,
): Promise<boolean> => {
  const url = new URL(presigned);
  const q = url.searchParams;
  const signedHeaders = q.get('X-Amz-SignedHeaders')!.split(';');
  const headers: Record<string, string> = { ...sent, host: url.host };
  const query = [...q.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    method,
    url.pathname,
    query,
    signedHeaders.map((h) => `${h}:${headers[h] ?? ''}\n`).join(''),
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const amzDate = q.get('X-Amz-Date')!;
  const [, date, region, service] = q.get('X-Amz-Credential')!.split('/') as [
    string,
    string,
    string,
    string,
  ];
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))),
  ].join('\n');
  let key: ArrayBuffer = await hmac(
    new TextEncoder().encode(`AWS4${config.secretAccessKey}`),
    date,
  );
  for (const part of [region, service, 'aws4_request']) key = await hmac(key, part);
  return hex(await hmac(key, toSign)) === q.get('X-Amz-Signature');
};

describe('presignPut contentLength', () => {
  const presign = (contentLength?: number) =>
    createR2S3Client(config).presignPut('panos/p1/original', {
      expiresInSeconds: 600,
      headers: { 'content-type': 'image/png' },
      contentLength,
    });

  it('signs content-length alongside content-type', async () => {
    const url = await presign(1024);
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
  });

  it('a PUT carrying the declared length and type matches the signature', async () => {
    const url = await presign(1024);
    await expect(
      signatureCovers(url, 'PUT', { 'content-length': '1024', 'content-type': 'image/png' }),
    ).resolves.toBe(true);
  });

  it('a PUT carrying any other length does not', async () => {
    const url = await presign(1024);
    for (const length of ['1025', '1023', '104857600']) {
      await expect(
        signatureCovers(url, 'PUT', { 'content-length': length, 'content-type': 'image/png' }),
      ).resolves.toBe(false);
    }
    await expect(
      signatureCovers(url, 'PUT', { 'content-length': '1024', 'content-type': 'image/jpeg' }),
    ).resolves.toBe(false);
  });

  it('the verifier agrees with the content-type-only URL too', async () => {
    const url = await presign();
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    await expect(signatureCovers(url, 'PUT', { 'content-type': 'image/png' })).resolves.toBe(true);
  });

  it('signs content-length on its own, without other headers', async () => {
    const url = await createR2S3Client(config).presignPut('panos/p1/original', {
      contentLength: 7,
    });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    await expect(signatureCovers(url, 'PUT', { 'content-length': '7' })).resolves.toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])('refuses a contentLength of %d', async (n) => {
    await expect(presign(n)).rejects.toThrow(/contentLength/);
  });
});

// upload-api makes each upload URL single-use by signing a condition into it.
describe('presignPut with a signed condition', () => {
  const presign = (headers: Record<string, string>) =>
    createR2S3Client(config).presignPut('panos/p1/original', {
      expiresInSeconds: 120,
      headers: { 'content-type': 'image/png', ...headers },
      contentLength: 1024,
    });
  const sent = { 'content-length': '1024', 'content-type': 'image/png' };

  it('signs if-none-match: a PUT must carry it to match', async () => {
    const url = await presign({ 'if-none-match': '*' });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    await expect(signatureCovers(url, 'PUT', { ...sent, 'if-none-match': '*' })).resolves.toBe(
      true,
    );
    // Dropping the condition (to PUT again and again) breaks the signature.
    await expect(signatureCovers(url, 'PUT', sent)).resolves.toBe(false);
  });

  it('signs if-match with the quoted ETag as given: only that ETag matches', async () => {
    const url = await presign({ 'if-match': '"abc123"' });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-match',
    );
    await expect(signatureCovers(url, 'PUT', { ...sent, 'if-match': '"abc123"' })).resolves.toBe(
      true,
    );
    for (const other of ['"other"', 'abc123', '*']) {
      await expect(signatureCovers(url, 'PUT', { ...sent, 'if-match': other })).resolves.toBe(
        false,
      );
    }
    await expect(signatureCovers(url, 'PUT', sent)).resolves.toBe(false);
    // Nor can If-Match be swapped for If-None-Match.
    await expect(signatureCovers(url, 'PUT', { ...sent, 'if-none-match': '*' })).resolves.toBe(
      false,
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

  it('sends no if-match unless asked', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createR2S3Client(config).put('k', '{}', { contentType: 'application/json' });
    expect(fetchMock.mock.calls[0]?.[0].headers.has('if-match')).toBe(false);
  });

  it('sends if-match, so R2 writes only over that ETag', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createR2S3Client(config).put('tiles/p/manifest.json', '{}', {
      contentType: 'application/json',
      ifMatch: '"abc123"',
    });
    expect(fetchMock.mock.calls[0]?.[0].headers.get('if-match')).toBe('"abc123"');
  });

  it('sends if-none-match: * for a create-only put', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createR2S3Client(config).put('accounts/o/deletion.json', '{}', {
      contentType: 'application/json',
      ifNoneMatch: '*',
    });
    expect(fetchMock.mock.calls[0]?.[0].headers.get('if-none-match')).toBe('*');
    expect(fetchMock.mock.calls[0]?.[0].headers.has('if-match')).toBe(false);
  });

  it('throws R2PreconditionFailedError on a 412, and does not retry it', async () => {
    const fetchMock = vi.fn(async () => new Response('PreconditionFailed', { status: 412 }));
    vi.stubGlobal('fetch', fetchMock);
    const put = createR2S3Client(config).put('tiles/p/manifest.json', '{}', {
      contentType: 'application/json',
      ifMatch: '"old"',
    });
    await expect(put).rejects.toBeInstanceOf(R2PreconditionFailedError);
    await expect(put).rejects.toThrow('R2 PUT tiles/p/manifest.json -> 412');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  describe('network-error retry', () => {
    // Runs backoff sleeps immediately and records their delays. Fake timers
    // don't fit: the sleep is scheduled only after aws4fetch's async signing
    // resolves, so there is no timer pending yet to advance.
    const instantBackoff = (): number[] => {
      const delays: number[] = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      return delays;
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('retries a thrown network error with backoff and succeeds on a later attempt', async () => {
      const delays = instantBackoff();
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createR2S3Client(config);

      await client.put('panos/p1/0/f/0-0.webp', new Uint8Array([1, 2, 3]), {
        contentType: 'image/webp',
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(delays).toEqual([250, 500]);
    });

    it('gives up after 2 retries and rethrows the network error', async () => {
      instantBackoff();
      const fetchMock = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      vi.stubGlobal('fetch', fetchMock);
      const client = createR2S3Client(config);

      await expect(
        client.put('panos/p1/0/f/0-0.webp', 'x', { contentType: 'image/webp' }),
      ).rejects.toThrow('fetch failed');
      // 1 initial attempt + 2 retries.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry a 4xx response', async () => {
      const fetchMock = vi.fn(async () => new Response('denied', { status: 403 }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createR2S3Client(config);

      await expect(
        client.put('panos/p1/0/f/0-0.webp', 'x', { contentType: 'image/webp' }),
      ).rejects.toThrow('R2 PUT panos/p1/0/f/0-0.webp -> 403');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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

describe('listPrefixes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (prefixes: string[], next?: string): Response =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>mybucket</Name>` +
        `<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>` +
        (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
        prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('') +
        `</ListBucketResult>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );

  it('lists the "folders" one level under a prefix with ListObjectsV2 and a / delimiter', async () => {
    const fetchMock = vi.fn(async (_req: Request) => page(['tiles/a/', 'tiles/b&amp;c/']));
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    expect(await client.listPrefixes('tiles/')).toEqual(['tiles/a/', 'tiles/b&c/']);
    const url = new URL(fetchMock.mock.calls[0]![0].url);
    expect(url.pathname).toBe('/mybucket');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('tiles/');
    expect(url.searchParams.get('delimiter')).toBe('/');
    expect(url.searchParams.has('continuation-token')).toBe(false);
  });

  it('follows continuation tokens until the listing is no longer truncated', async () => {
    const fetchMock = vi
      .fn(async (_req: Request) => page([]))
      .mockResolvedValueOnce(page(['tiles/a/'], 'tok/1+='))
      .mockResolvedValueOnce(page(['tiles/b/']));
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    expect(await client.listPrefixes('tiles/')).toEqual(['tiles/a/', 'tiles/b/']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new URL(fetchMock.mock.calls[1]![0].url);
    expect(second.searchParams.get('continuation-token')).toBe('tok/1+=');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 })),
    );
    const client = createR2S3Client(config);
    await expect(client.listPrefixes('tiles/')).rejects.toThrow(/R2 LIST tiles\/ -> 403/);
  });
});

describe('listObjects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (objects: { key: string; size: number }[], next?: string): Response =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>mybucket</Name>` +
        `<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>` +
        (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
        objects
          .map(
            (o) =>
              `<Contents><Key>${o.key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>` +
              `<ETag>"x"</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
          )
          .join('') +
        `</ListBucketResult>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );

  it('lists every object under a prefix with its size, without a delimiter', async () => {
    const fetchMock = vi.fn(async (_req: Request) =>
      page([
        { key: 'panos/o/p1/original', size: 1024 },
        { key: 'panos/o/a&amp;b/config.json', size: 12 },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    expect(await client.listObjects('panos/o/')).toEqual([
      { key: 'panos/o/p1/original', size: 1024 },
      { key: 'panos/o/a&b/config.json', size: 12 },
    ]);
    const url = new URL(fetchMock.mock.calls[0]![0].url);
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('panos/o/');
    expect(url.searchParams.has('delimiter')).toBe(false);
  });

  it('follows continuation tokens', async () => {
    const fetchMock = vi
      .fn(async (_req: Request) => page([]))
      .mockResolvedValueOnce(page([{ key: 'a', size: 1 }], 'tok'))
      .mockResolvedValueOnce(page([{ key: 'b', size: 2 }]));
    vi.stubGlobal('fetch', fetchMock);
    const client = createR2S3Client(config);

    expect(await client.listObjects('')).toEqual([
      { key: 'a', size: 1 },
      { key: 'b', size: 2 },
    ]);
    expect(new URL(fetchMock.mock.calls[1]![0].url).searchParams.get('continuation-token')).toBe(
      'tok',
    );
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 })),
    );
    const client = createR2S3Client(config);
    await expect(client.listObjects('panos/')).rejects.toThrow(/R2 LIST panos\/ -> 403/);
  });
});

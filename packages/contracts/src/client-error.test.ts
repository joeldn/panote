import { describe, expect, it } from 'vitest';

import {
  ClientErrorReportSchema,
  MAX_ERROR_FRAMES,
  MAX_ERROR_MESSAGE_LENGTH,
  scrubErrorText,
} from './client-error.js';

describe('scrubErrorText', () => {
  it('drops a query string and fragment but keeps the line and column of a frame', () => {
    expect(scrubErrorText('at f (https://panote.dev/assets/index-Ab12.js?v=1#x:10:5)')).toBe(
      'at f (https://panote.dev/assets/index-Ab12.js:10:5)',
    );
    expect(scrubErrorText('f@https://panote.dev/assets/a.js?token=abc:3:7')).toBe(
      'f@https://panote.dev/assets/a.js:3:7',
    );
  });

  it('drops a query string or fragment in a message, wherever the URL ends', () => {
    expect(scrubErrorText('Failed to load https://cdn.panote.dev/x.json?sig=s3cret now')).toBe(
      'Failed to load https://cdn.panote.dev/x.json now',
    );
    expect(scrubErrorText("GET 'https://panote.dev/app/callback?code=c&state=s'")).toBe(
      "GET 'https://panote.dev/app/callback'",
    );
    expect(scrubErrorText('https://panote.dev/#access_token=t')).toBe('https://panote.dev/');
  });

  it('masks emails and tour slugs', () => {
    expect(scrubErrorText('no account for jane.doe+x@example.co.uk')).toBe(
      'no account for <email>',
    );
    expect(scrubErrorText('https://cdn.panote.dev/slugs/my-secret-tour.json')).toBe(
      'https://cdn.panote.dev/slugs/:slug',
    );
    expect(scrubErrorText('at /s/my-secret-tour/embed')).toBe('at /s/:slug/embed');
  });

  it('drops a query string or fragment from relative paths, bare hosts and data: URLs', () => {
    expect(
      scrubErrorText('response from /api/admin/tours/x?include=configs failed validation'),
    ).toBe('response from /api/admin/tours/:tourId failed validation');
    expect(scrubErrorText('GET /api/upload-url?owner=me#frag')).toBe('GET /api/upload-url');
    expect(scrubErrorText('embed vimeo.com/123?h=SECRET failed')).toBe(
      'embed vimeo.com/123 failed',
    );
    expect(scrubErrorText('at player.vimeo.com:443/v?h=s:1:2')).toBe(
      'at player.vimeo.com:443/v:1:2',
    );
    expect(scrubErrorText('load data:image/png;base64,AAAA#xywh=1 failed')).toBe(
      'load data:image/png;base64,AAAA failed',
    );
    expect(scrubErrorText('blob:https://panote.dev/abc?x=1')).toBe('blob:https://panote.dev/abc');
  });

  it.each([
    ['url=https://panote.dev/p?token=SECRET', 'url=https://panote.dev/p'],
    ['URL:https://panote.dev/p?token=SECRET', 'URL:https://panote.dev/p'],
    ['Failed,https://panote.dev/p?token=SECRET', 'Failed,https://panote.dev/p'],
    ['[https://panote.dev/p?token=SECRET]', '[https://panote.dev/p'],
    ['src=/api/x?token=SECRET', 'src=/api/x'],
    ['what?https://panote.dev/p?token=SECRET', 'what?https://panote.dev/p'],
    ['192.168.1.1/p?token=SECRET', '192.168.1.1/p'],
    ['localhost:8787/p?token=SECRET', 'localhost:8787/p'],
    ['ref=vimeo.com/1?h=SECRET', 'ref=vimeo.com/1'],
    ['img=data:image/png;base64,AA#SECRET', 'img=data:image/png;base64,AA'],
    // Never split at `=` or `,`: every later query value goes too.
    ['https://panote.dev/p?a=1,b=https://x.dev/?c=SECRET', 'https://panote.dev/p'],
  ])('drops the query of a URL glued to a prefix: %s', (text, scrubbed) => {
    expect(scrubErrorText(text)).toBe(scrubbed);
    expect(scrubErrorText(`at ${text} now`)).toBe(`at ${scrubbed} now`);
  });

  it("keeps prose's question marks and hashes", () => {
    for (const text of [
      'is it valid? no',
      'what now?!',
      'Expected ")" but got "?"',
      'issue #12 again',
      'TypeError: x?.y is not a function',
      'metadata:x?y',
      'and/or?',
      'v1.2?',
    ])
      expect(scrubErrorText(text)).toBe(text);
  });

  it('masks tour ids in page, API and R2 key paths', () => {
    expect(scrubErrorText('GET https://cdn.panote.dev/pub/tours/t_123.json 404')).toBe(
      'GET https://cdn.panote.dev/pub/tours/:tourId 404',
    );
    expect(scrubErrorText('POST /api/tours/t_123/like failed')).toBe(
      'POST /api/tours/:tourId/like failed',
    );
    expect(scrubErrorText('PUT /api/admin/tours/t_123/publish 409')).toBe(
      'PUT /api/admin/tours/:tourId/publish 409',
    );
    expect(scrubErrorText('at /app/t/t_123/share/link')).toBe('at /app/t/:tourId/share/link');
    expect(scrubErrorText('at /S/MySlug/embed and /Pub/Tours/T1.json')).toBe(
      'at /S/:slug/embed and /Pub/Tours/:tourId',
    );
  });

  it('leaves an @ with no local part alone', () => {
    expect(scrubErrorText('@panote.dev')).toBe('@panote.dev');
    expect(scrubErrorText('see /x/@panote.dev and a:@b.co')).toBe('see /x/@panote.dev and a:@b.co');
  });

  it('masks every email in a token and leaves Firefox frames alone', () => {
    expect(scrubErrorText('a@b.co,c.d@e-f.example.org')).toBe('<email>,<email>');
    expect(scrubErrorText('render@https://panote.dev/a.js:1:2')).toBe(
      'render@https://panote.dev/a.js:1:2',
    );
  });

  it.each([
    ['a JWT', 'jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln failed', 'jwt <jwt> failed'],
    ['a JWE', 'eyJhbGci.a.b.c.d', '<jwt>'],
    [
      'a bearer token',
      'Authorization: Bearer abc.def-123 rejected',
      'Authorization: Bearer <token> rejected',
    ],
    [
      'a code and state pair',
      'callback code=Zx9&state=s3 failed',
      'callback code=<redacted>&state=<redacted> failed',
    ],
    [
      'a fragment token',
      '#access_token=AT&id_token=IT&token_type=x',
      '#access_token=<redacted>&id_token=<redacted>&token_type=x',
    ],
    [
      'any *_token',
      'refresh_token=R,client_secret=S',
      'refresh_token=<redacted>,client_secret=<redacted>',
    ],
    [
      'a presigned URL signature',
      'X-Amz-Signature=abc;sig=d',
      'X-Amz-Signature=<redacted>;sig=<redacted>',
    ],
    ['a %40-encoded email', 'no user jane%40example.com', 'no user <email>'],
    ['a %40-encoded email in a path', '/u/Jane%40Example.Com/x', '/u/<email>/x'],
    ['an IDN domain', 'for jane@exämple.de now', 'for <email> now'],
    ['a non-ASCII local part', 'for josé.müller@example.com', 'for <email>'],
    ['a punycode TLD', 'a@b.xn--p1ai', '<email>'],
    [
      'URL userinfo',
      'GET https://joel:pw@cdn.example.com/x failed',
      'GET https://<userinfo>@cdn.example.com/x failed',
    ],
    [
      'userinfo without a password',
      'wss://joel@sock.example.com/',
      'wss://<userinfo>@sock.example.com/',
    ],
  ])('masks %s', (_label, text, scrubbed) => {
    expect(scrubErrorText(text)).toBe(scrubbed);
  });

  it('keeps what only looks like a secret', () => {
    for (const text of [
      'keyJar is fine',
      'barcode is fine',
      'decode=1 and encodestate=2',
      'see %40 alone',
      'react@18.3.1',
      'Bearer',
      'at https://panote.dev/a.js:1:2',
    ])
      expect(scrubErrorText(text)).toBe(text);
  });

  it('masks the owner segment of every owner-keyed R2 key', () => {
    expect(scrubErrorText('R2 GET panos/Z29vZ2xl/p1/original -> 403')).toBe(
      'R2 GET panos/:owner/p1/original -> 403',
    );
    expect(scrubErrorText('tours/Z29v/t1/tour.json')).toBe('tours/:owner/t1/tour.json');
    expect(scrubErrorText('accounts/Z29v/deletion.json')).toBe('accounts/:owner/deletion.json');
    expect(scrubErrorText('upload-log/Z29v/20260101T000000000Z-p1')).toBe(
      'upload-log/:owner/20260101T000000000Z-p1',
    );
    expect(scrubErrorText('https://x.r2.cloudflarestorage.com/b/panos/Z29v/p1/original')).toBe(
      'https://x.r2.cloudflarestorage.com/b/panos/:owner/p1/original',
    );
    expect(scrubErrorText('backup/2026-01-01/tours/Z29v/t1/tour.json')).toBe(
      'backup/2026-01-01/tours/:owner/t1/tour.json',
    );
  });

  it('masks pano and tour ids in R2 keys and CDN URLs', () => {
    expect(scrubErrorText('GET https://cdn.panote.dev/tiles/p_1/v1/0/px/0-0.webp 404')).toBe(
      'GET https://cdn.panote.dev/tiles/:panoId/v1/0/px/0-0.webp 404',
    );
    expect(scrubErrorText('R2 PUT tiles/p_1/manifest.json')).toBe(
      'R2 PUT tiles/:panoId/manifest.json',
    );
    expect(scrubErrorText('tile-gc/p_1/v.json')).toBe('tile-gc/:panoId/v.json');
    expect(scrubErrorText('pub/plans/t_1/plan.webp and tour-owners/t_1.json')).toBe(
      'pub/plans/:tourId/plan.webp and tour-owners/:tourId',
    );
    expect(scrubErrorText('explore/tours/t_1.json explore/hidden/t_2.json')).toBe(
      'explore/tours/:tourId explore/hidden/:tourId',
    );
    expect(scrubErrorText('DELETE /api/admin/panos/p_1 500')).toBe(
      'DELETE /api/admin/panos/:panoId 500',
    );
  });

  it('keeps routes that share a word with a key root', () => {
    expect(scrubErrorText('at /app/panos/unused')).toBe('at /app/panos/unused');
    expect(scrubErrorText('/api/tours/t_1/like')).toBe('/api/tours/:tourId/like');
  });

  it('masks bare UUIDs', () => {
    expect(scrubErrorText('pano 0b6f1c3e-8a2d-4f7b-9c1e-2d3f4a5b6c7d not found')).toBe(
      'pano <id> not found',
    );
    expect(scrubErrorText('0B6F1C3E-8A2D-4F7B-9C1E-2D3F4A5B6C7D')).toBe('<id>');
    expect(scrubErrorText('0b6f1c3e-8a2d-4f7b-9c1e-2d3f4a5b6c7d0')).toBe(
      '0b6f1c3e-8a2d-4f7b-9c1e-2d3f4a5b6c7d0',
    );
  });

  // Linear, not backtracking: these took seconds each before. The bound is
  // generous on purpose; a regression is orders of magnitude slower.
  it.each([
    ['one long word', 'a'.repeat(100_000)],
    ['a long dotted host', `${'a.'.repeat(50_000)}!?x`],
    ['many @', `${'a@'.repeat(50_000)}`],
    ['a long URL', `https://x.dev/${'a'.repeat(100_000)}?q=1`],
    ['long local parts', `${'a'.repeat(50_000)}@${'b'.repeat(50_000)}`],
    ['many host candidates', `${'=a.bc'.repeat(20_000)}!?x`],
    ['many path and IP candidates', `${',/1.2.3.4:5'.repeat(10_000)}?x`],
    ['many schemes', `${'a://'.repeat(25_000)}?x`],
    ['many userinfo candidates', `${'a://b:c@'.repeat(12_000)}`],
    ['one long authority', `a://${'b:'.repeat(50_000)}@x`],
    ['many JWT starts', `${'eyJ.'.repeat(25_000)}`],
    ['many secret keys', `${'a_b_token_'.repeat(10_000)}`],
    ['many secret pairs', `${'code=&'.repeat(16_000)}`],
    ['many encoded @', `${'a%40'.repeat(25_000)}`],
    ['a long unicode domain', `a@${'ä.'.repeat(50_000)}`],
    ['many key roots', `${'panos/'.repeat(16_000)}`],
    ['many route-like roots', `${'api/tours/'.repeat(10_000)}`],
    ['bearer before a long gap', `Bearer${' '.repeat(100_000)})`],
    ['many bearers', `${'Bearer '.repeat(14_000)}`],
    ['near-UUIDs', `${'0b6f1c3e-8a2d-4f7b-9c1e-'.repeat(4_000)}`],
  ])('scrubs %s of ~100k chars quickly', (_label, text) => {
    const started = performance.now();
    scrubErrorText(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('leaves text without URLs alone', () => {
    const text = "Cannot read properties of undefined (reading 'x')";
    expect(scrubErrorText(text)).toBe(text);
  });
});

describe('ClientErrorReportSchema', () => {
  const report = {
    app: 'website',
    release: 'BxR2v9Qe',
    kind: 'error',
    message: 'TypeError: boom',
    stack: ['at f (https://panote.dev/assets/index-BxR2v9Qe.js:1:2)'],
    path: '/s/:slug',
  };

  it('accepts a well-formed report', () => {
    expect(ClientErrorReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    ['an unknown app', { app: 'demo' }],
    ['an unknown kind', { kind: 'warning' }],
    ['a release with a slash', { release: 'a/b' }],
    ['a long message', { message: 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH + 1) }],
    ['too many frames', { stack: Array<string>(MAX_ERROR_FRAMES + 1).fill('at f') }],
    ['a path with a query string', { path: '/app?x=1' }],
    ['a path with a fragment', { path: '/app#x' }],
    ['a full URL as the path', { path: 'https://panote.dev/' }],
  ])('rejects %s', (_label, patch) => {
    expect(ClientErrorReportSchema.safeParse({ ...report, ...patch }).success).toBe(false);
  });
});

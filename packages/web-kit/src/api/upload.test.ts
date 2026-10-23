import { describe, expect, it, vi } from 'vitest';

import { json } from '../__fixtures__/helpers.js';
import { AuthRequiredError } from '../auth.js';
import { ApiError, ApiSchemaError } from './http.js';
import {
  createUploadApi,
  MAX_UPLOAD_BYTES,
  putFile,
  UploadAbortedError,
  validateUploadFile,
  type XhrLike,
} from './upload.js';

class FakeXhr implements XhrLike {
  status = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sent: Blob | undefined;
  aborted = false;
  upload: XhrLike['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(n: string, v: string) {
    // As XHR does: a header set twice is joined, not replaced.
    this.headers[n] = n in this.headers ? `${this.headers[n]}, ${v}` : v;
  }
  send(body: Blob) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

const blob = (n = 10) => new Blob([new Uint8Array(n)], { type: 'image/png' });

describe('putFile', () => {
  it('PUTs with the signed content-type and reports progress from XHR events', async () => {
    const xhr = new FakeXhr();
    const onProgress = vi.fn();
    const p = putFile('https://r2.test/put', blob(), {
      contentType: 'image/png',
      onProgress,
      createXhr: () => xhr,
    });
    expect(xhr.method).toBe('PUT');
    expect(xhr.headers).toEqual({ 'content-type': 'image/png' });
    xhr.progress(5, 10);
    xhr.finish(200);
    await expect(p).resolves.toBeUndefined();
    expect(onProgress.mock.calls).toEqual([
      [5, 10],
      [10, 10],
    ]);
  });

  it('sends the presign’s signed headers, each once', async () => {
    const xhr = new FakeXhr();
    const p = putFile('https://r2.test/put', blob(), {
      contentType: 'image/png',
      headers: { 'Content-Type': 'image/png', 'If-Match': '"e1"' },
      createXhr: () => xhr,
    });
    expect(xhr.headers).toEqual({ 'content-type': 'image/png', 'if-match': '"e1"' });
    xhr.finish(200);
    await p;
    const fresh = new FakeXhr();
    void putFile('u', blob(), {
      contentType: 'image/webp',
      headers: { 'content-type': 'image/webp', 'if-none-match': '*' },
      createXhr: () => fresh,
    });
    expect(fresh.headers).toEqual({ 'content-type': 'image/webp', 'if-none-match': '*' });
  });

  it('a 412 (the URL was already used) rejects like any other non-2xx', async () => {
    const xhr = new FakeXhr();
    const p = putFile('u', blob(), {
      contentType: 'image/png',
      headers: { 'if-none-match': '*' },
      createXhr: () => xhr,
    });
    xhr.finish(412);
    await expect(p).rejects.toMatchObject({ status: 412 });
  });

  it('rejects on a non-2xx status and on network error', async () => {
    const a = new FakeXhr();
    const pa = putFile('u', blob(), { contentType: 'image/png', createXhr: () => a });
    a.finish(403);
    await expect(pa).rejects.toMatchObject({ status: 403 });
    const b = new FakeXhr();
    const pb = putFile('u', blob(), { contentType: 'image/png', createXhr: () => b });
    b.onerror?.();
    await expect(pb).rejects.toBeInstanceOf(ApiError);
  });

  it('aborts the XHR when the signal fires', async () => {
    const xhr = new FakeXhr();
    const ac = new AbortController();
    const p = putFile('u', blob(), {
      contentType: 'image/png',
      signal: ac.signal,
      createXhr: () => xhr,
    });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(UploadAbortedError);
    expect(xhr.aborted).toBe(true);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const xhr = new FakeXhr();
    const ac = new AbortController();
    ac.abort();
    await expect(
      putFile('u', blob(), { contentType: 'image/png', signal: ac.signal, createXhr: () => xhr }),
    ).rejects.toBeInstanceOf(UploadAbortedError);
    expect(xhr.sent).toBeUndefined();
  });
});

describe('createUploadApi', () => {
  it('posts the typed presign body and validates the response', async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) =>
      json({ panoId: 'p1', key: 'panos/x/p1/original', url: 'https://r2.test/put?sig' }),
    );
    const api = createUploadApi({ fetch, getToken: async () => 't' });
    await expect(api.presign({ contentType: 'image/jpeg', size: 5 })).resolves.toMatchObject({
      panoId: 'p1',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/upload-url');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      contentType: 'image/jpeg',
      size: 5,
    });
  });

  it('passes on the headers the PUT must send', async () => {
    const headers = { 'content-type': 'image/jpeg', 'if-match': '"e1"' };
    const fetch = vi.fn(async () =>
      json({ panoId: 'p1', key: 'k', url: 'https://r2.test/put?sig', headers }),
    );
    const api = createUploadApi({ fetch, getToken: async () => 't' });
    await expect(
      api.presign({ contentType: 'image/jpeg', size: 5, panoId: 'p1' }),
    ).resolves.toMatchObject({ headers });
    const bad = vi.fn(async () =>
      json({ panoId: 'p1', key: 'k', url: 'https://r2.test/x', headers: { 'if-match': 1 } }),
    );
    await expect(
      createUploadApi({ fetch: bad, getToken: async () => 't' }).presign({
        contentType: 'image/png',
        size: 1,
      }),
    ).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('rejects an invalid body, and a replace presign for a different pano', async () => {
    const bad = vi.fn(async () => json({ panoId: 'p1', key: 'k', url: 'not a url' }));
    await expect(
      createUploadApi({ fetch: bad, getToken: async () => 't' }).presign({
        contentType: 'image/png',
        size: 1,
      }),
    ).rejects.toBeInstanceOf(ApiSchemaError);
    const other = vi.fn(async () => json({ panoId: 'p2', key: 'k', url: 'https://r2.test/x' }));
    await expect(
      createUploadApi({ fetch: other, getToken: async () => 't' }).presign({
        contentType: 'image/png',
        size: 1,
        panoId: 'p1',
      }),
    ).rejects.toThrow(/different panoId/);
  });

  it('asks for a plan image URL with kind plan and validates the response', async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) =>
      json({ planId: 'pl1', key: 'pub/plans/t1/pl1.webp', url: 'https://r2.test/put?sig' }),
    );
    const api = createUploadApi({ fetch, getToken: async () => 't' });
    await expect(
      api.presignPlan({ tourId: 't1', contentType: 'image/webp', size: 9 }),
    ).resolves.toEqual({
      planId: 'pl1',
      key: 'pub/plans/t1/pl1.webp',
      url: 'https://r2.test/put?sig',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/upload-url');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      kind: 'plan',
      tourId: 't1',
      contentType: 'image/webp',
      size: 9,
    });
    const bad = vi.fn(async () => json({ panoId: 'p1', key: 'k', url: 'https://r2.test/x' }));
    await expect(
      createUploadApi({ fetch: bad, getToken: async () => 't' }).presignPlan({
        tourId: 't1',
        contentType: 'image/png',
        size: 1,
      }),
    ).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('surfaces 4xx errors with the server message', async () => {
    const fetch = vi.fn(async () => json({ error: 'original not found' }, 404));
    await expect(
      createUploadApi({ fetch, getToken: async () => 't' }).presign({
        contentType: 'image/png',
        size: 1,
        panoId: 'p1',
      }),
    ).rejects.toMatchObject({ status: 404, message: '404: original not found' });
  });
});

describe('createUploadApi getUsage', () => {
  it('reads the usage with a GET on the same route', async () => {
    const usage = {
      panos: 2,
      bytes: 10,
      uploadsToday: 1,
      limits: { maxPanos: 500, maxBytes: null, maxUploadsPerDay: 50 },
    };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json(usage));
    await expect(createUploadApi({ fetch, getToken: async () => 't' }).getUsage()).resolves.toEqual(
      usage,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/upload-url');
    expect(fetch.mock.calls[0]?.[1]).toEqual({
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
  });
});

describe('createUploadApi auth', () => {
  it('maps a 401 to AuthRequiredError', async () => {
    const fetch = vi.fn(async () => json({ error: 'unauthorized' }, 401));
    await expect(
      createUploadApi({ fetch, getToken: async () => 't' }).presign({
        contentType: 'image/png',
        size: 1,
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('validateUploadFile', () => {
  it('accepts jpeg/png/webp up to 150 MiB', () => {
    expect(validateUploadFile({ type: 'image/webp', size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(validateUploadFile({ type: 'image/gif', size: 1 })?.code).toBe('type');
    expect(validateUploadFile({ type: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 })?.code).toBe(
      'size',
    );
    expect(validateUploadFile({ type: 'image/jpeg', size: 0 })?.code).toBe('empty');
  });
});

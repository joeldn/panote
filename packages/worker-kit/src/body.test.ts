import { describe, expect, it, vi } from 'vitest';

import { readBodyText, readJsonBody } from './body.js';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://x/', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

// A chunked body: `count` chunks of `size` bytes, with no Content-Length. It counts
// what was pulled and whether the reader cancelled it.
const chunked = (count: number, size: number) => {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled === count) {
          controller.close();
          return;
        }
        seen.pulled += 1;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { req: post(stream), seen };
};

describe('readBodyText', () => {
  it('reads a body up to the cap, exactly at it included', async () => {
    expect(await readBodyText(post('abc'), 3)).toEqual({ ok: true, text: 'abc' });
    expect(await readBodyText(post('é'), 2)).toEqual({ ok: true, text: 'é' });
  });

  it('reads no body as empty text', async () => {
    expect(await readBodyText(new Request('https://x/'), 10)).toEqual({ ok: true, text: '' });
  });

  it('413s on Content-Length alone, without reading the body', async () => {
    const pull = vi.fn();
    const req = post(new ReadableStream({ pull }, { highWaterMark: 0 }), {
      'content-length': '11',
    });
    expect(await readBodyText(req, 10)).toEqual({ ok: false, status: 413 });
    expect(pull).not.toHaveBeenCalled();
  });

  it('counts bytes, not characters', async () => {
    // Two characters, four bytes.
    expect(await readBodyText(post('éé'), 3)).toEqual({ ok: false, status: 413 });
  });

  it('stops a chunked body with no Content-Length once it passes the cap, and cancels it', async () => {
    const { req, seen } = chunked(100, 1024);
    expect(req.headers.get('content-length')).toBeNull();
    expect(await readBodyText(req, 4 * 1024)).toEqual({ ok: false, status: 413 });
    // Five chunks pass the 4 KiB cap; the other 95 are never pulled.
    expect(seen.pulled).toBe(5);
    expect(seen.cancelled).toBe(true);
  });

  it('reads a chunked body under the cap whole', async () => {
    const { req, seen } = chunked(4, 1024);
    const out = await readBodyText(req, 4 * 1024);
    expect(out).toEqual({ ok: true, text: ' '.repeat(4 * 1024) });
    expect(seen.cancelled).toBe(false);
  });
});

describe('readJsonBody', () => {
  it('parses JSON whatever the content-type', async () => {
    const req = post('{"a":1}', { 'content-type': 'text/plain' });
    expect(await readJsonBody(req, 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reads an empty or blank body as {}', async () => {
    expect(await readJsonBody(post(''), 100)).toEqual({ ok: true, value: {} });
    expect(await readJsonBody(post('  \n'), 100)).toEqual({ ok: true, value: {} });
  });

  it('400s a body that is not JSON', async () => {
    expect(await readJsonBody(post('{nope'), 100)).toEqual({ ok: false, status: 400 });
  });

  it('413s a body over the cap before parsing it', async () => {
    expect(await readJsonBody(post(JSON.stringify({ pad: 'x'.repeat(100) })), 100)).toEqual({
      ok: false,
      status: 413,
    });
  });
});

describe('readBodyText decoding', () => {
  it('decodes a character split across chunks', async () => {
    const bytes = new TextEncoder().encode('a漢b');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // '漢' is 3 bytes: split it between chunks.
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 3));
        controller.enqueue(bytes.slice(3));
        controller.close();
      },
    });
    expect(await readBodyText(post(stream), 10)).toEqual({ ok: true, text: 'a漢b' });
  });

  it('flushes a character cut off at the end of the body as U+FFFD, not dropped', async () => {
    const bytes = new TextEncoder().encode('a漢');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // The body ends two bytes into '漢', those two split across the last chunks.
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 3));
        controller.close();
      },
    });
    expect(await readBodyText(post(stream), 10)).toEqual({ ok: true, text: 'a\uFFFD' });
  });
});

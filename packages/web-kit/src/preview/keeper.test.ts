import { describe, expect, it, vi } from 'vitest';

import type { DecodePreviewOptions } from './client.js';
import type { DecodedPreview } from './decode.js';
import { keepPreview, readMaxTextureSize, type PreviewDecoder } from './keeper.js';

interface FakeImage {
  from: string;
  closed: boolean;
  close(): void;
}

function decoded(from: string, stash: Blob | null): DecodedPreview {
  const image: FakeImage = {
    from,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  return {
    source: {
      width: 8,
      height: 4,
      patches: [{ x: 0, y: 0, w: 8, h: 4, image: image as unknown as ImageBitmap }],
    },
    stash,
    stats: { sourceWidth: 8, sourceHeight: 4, resize: 'none', decodeMs: 0, totalMs: 0 },
  };
}

const imageOf = (s: { patches: Array<{ image: unknown }> }) => s.patches[0]!.image as FakeImage;

const file = new Blob(['original'], { type: 'image/jpeg' });
const stash = new Blob(['stash'], { type: 'image/webp' });

/** A decoder that labels each result by what it decoded, and records its calls. */
function fakeDecoder(first: DecodedPreview | null | Error = decoded('file', stash)) {
  const calls: Array<{ blob: Blob; options: DecodePreviewOptions }> = [];
  const decode = vi.fn<PreviewDecoder>(async (blob, options) => {
    calls.push({ blob, options });
    if (calls.length === 1) {
      if (first instanceof Error) throw first;
      return first;
    }
    return decoded(blob === stash ? 'stash' : 'file-again', null);
  });
  return { decode, calls };
}

describe('keepPreview', () => {
  it('decodes at once with the tier and texture limit, without a signal-less call', async () => {
    const d = fakeDecoder();
    const keeper = keepPreview(file, { tier: 'phone', maxTextureSize: 4096, decode: d.decode });
    expect(keeper.available).toBe(false);
    await expect(keeper.ready).resolves.toBe(true);
    expect(keeper.available).toBe(true);
    expect(d.calls[0]?.blob).toBe(file);
    expect(d.calls[0]?.options).toMatchObject({ tier: 'phone', maxTextureSize: 4096 });
    expect(d.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
  });

  it('hands out a fresh source per show: the first decode once, then the stash re-decoded', async () => {
    const d = fakeDecoder();
    const keeper = keepPreview(file, { decode: d.decode });
    const a = await keeper.next();
    const b = await keeper.next();
    const c = await keeper.next();
    expect(imageOf(a).from).toBe('file');
    expect(imageOf(b).from).toBe('stash');
    expect(imageOf(c).from).toBe('stash');
    expect(new Set([a, b, c]).size).toBe(3);
    // A stash decode doesn't encode another stash.
    expect(d.calls.slice(1).map((x) => x.options.stash)).toEqual([false, false]);
  });

  it('re-decodes the file itself when no stash could be encoded', async () => {
    const d = fakeDecoder(decoded('file', null));
    const keeper = keepPreview(file, { decode: d.decode });
    await keeper.next();
    expect(imageOf(await keeper.next()).from).toBe('file-again');
    expect(d.calls[1]?.blob).toBe(file);
  });

  it('a failed or skipped decode is just no preview: ready is false, next rejects', async () => {
    for (const first of [new Error('corrupt'), null]) {
      const keeper = keepPreview(file, { decode: fakeDecoder(first).decode });
      await expect(keeper.ready).resolves.toBe(false);
      expect(keeper.available).toBe(false);
      await expect(keeper.next()).rejects.toThrow('No preview');
    }
  });

  it('a decoder that throws synchronously is no preview either', async () => {
    const keeper = keepPreview(file, {
      decode: () => {
        throw new Error('no Worker');
      },
    });
    await expect(keeper.ready).resolves.toBe(false);
  });

  it('release closes the unshown first decode; the next show uses the stash', async () => {
    const d = fakeDecoder();
    const keeper = keepPreview(file, { decode: d.decode });
    await keeper.ready;
    const first = (await d.decode.mock.results[0]!.value)!.source;
    keeper.release();
    expect(imageOf(first).closed).toBe(true);
    expect(imageOf(await keeper.next()).from).toBe('stash');
  });

  it('dispose aborts the decode, frees what it holds and refuses later shows', async () => {
    const d = fakeDecoder();
    const keeper = keepPreview(file, { decode: d.decode });
    await keeper.ready;
    const first = (await d.decode.mock.results[0]!.value)!.source;
    keeper.dispose();
    expect(d.calls[0]?.options.signal?.aborted).toBe(true);
    expect(imageOf(first).closed).toBe(true);
    expect(keeper.available).toBe(false);
    await expect(keeper.next()).rejects.toThrow('No preview');
  });

  it('a decode that lands after dispose is closed, not kept', async () => {
    let finish!: (d: DecodedPreview) => void;
    const keeper = keepPreview(file, {
      decode: () => new Promise<DecodedPreview>((r) => (finish = r)),
    });
    keeper.dispose();
    const late = decoded('file', stash);
    finish(late);
    await expect(keeper.ready).resolves.toBe(false);
    expect(imageOf(late.source).closed).toBe(true);
  });

  it('a stash re-decode that lands after dispose is closed and rejected', async () => {
    let finish!: (d: DecodedPreview) => void;
    let n = 0;
    const keeper = keepPreview(file, {
      decode: async () =>
        n++ === 0 ? decoded('file', stash) : new Promise<DecodedPreview>((r) => (finish = r)),
    });
    await keeper.next();
    const pending = keeper.next();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    keeper.dispose();
    const late = decoded('stash', null);
    finish(late);
    await expect(pending).rejects.toThrow('No preview');
    expect(imageOf(late.source).closed).toBe(true);
  });
});

describe('readMaxTextureSize', () => {
  const canvas = (size: unknown, lose = vi.fn()) => ({
    getContext: () => ({
      MAX_TEXTURE_SIZE: 0x0d33,
      getParameter: (p: number) => (p === 0x0d33 ? size : null),
      getExtension: () => ({ loseContext: lose }),
    }),
  });

  it('reads MAX_TEXTURE_SIZE and releases the context', () => {
    const lose = vi.fn();
    expect(readMaxTextureSize(() => canvas(16384, lose) as never)).toBe(16384);
    expect(lose).toHaveBeenCalled();
  });

  it('is undefined without WebGL2, on a bad value, or when the probe throws', () => {
    expect(readMaxTextureSize(() => ({ getContext: () => null }))).toBeUndefined();
    expect(readMaxTextureSize(() => canvas(0) as never)).toBeUndefined();
    expect(
      readMaxTextureSize(() => {
        throw new Error('blocked');
      }),
    ).toBeUndefined();
  });
});

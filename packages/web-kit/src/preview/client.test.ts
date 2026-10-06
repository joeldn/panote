import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodePreview, type WorkerLike } from './client.js';
import type { DecodedPreview } from './decode.js';
import type { DecodeMessage, DecodeResponse } from './protocol.js';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  posted: DecodeMessage[] = [];
  terminated = false;
  postMessage(message: unknown) {
    this.posted.push(message as DecodeMessage);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: DecodeResponse) {
    this.onmessage?.({ data } as MessageEvent);
  }
  crash(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function result(): DecodedPreview {
  const image = { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap;
  return {
    source: { width: 4, height: 2, patches: [{ x: 0, y: 0, w: 4, h: 2, image }] },
    stash: null,
    stats: { sourceWidth: 4, sourceHeight: 2, resize: 'none', decodeMs: 1, totalMs: 2 },
  };
}

const file = new Blob(['x']);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodePreview', () => {
  it('posts the file, tier and limits, then resolves and terminates', async () => {
    const w = new FakeWorker();
    const run = decodePreview(file, {
      tier: 'phone',
      maxTextureSize: 2048,
      createWorker: () => w,
    });
    expect(w.posted).toEqual([
      {
        type: 'decode',
        file,
        request: { tier: 'phone', limits: { maxTextureSize: 2048, maxWidth: undefined } },
      },
    ]);
    const r = result();
    w.reply({ type: 'done', result: r });
    await expect(run).resolves.toBe(r);
    expect(w.terminated).toBe(true);
  });

  it('passes stash: false through, and only when given', () => {
    const w = new FakeWorker();
    void decodePreview(file, { tier: 'desktop', stash: false, createWorker: () => w });
    expect(w.posted[0]?.request).toMatchObject({ tier: 'desktop', stash: false });
  });

  it('picks the tier from the device when not given', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const w = new FakeWorker();
    void decodePreview(file, { createWorker: () => w });
    expect(w.posted[0]?.request.tier).toBe('phone');
  });

  it('resolves null when the worker skips the preview', async () => {
    const w = new FakeWorker();
    const run = decodePreview(file, { tier: 'phone', createWorker: () => w });
    w.reply({ type: 'done', result: null });
    await expect(run).resolves.toBeNull();
  });

  it('rejects on an error reply or a worker crash', async () => {
    const a = new FakeWorker();
    const runA = decodePreview(file, { tier: 'phone', createWorker: () => a });
    a.reply({ type: 'error', message: 'corrupt JPEG' });
    await expect(runA).rejects.toThrow('preview decode failed: corrupt JPEG');

    const b = new FakeWorker();
    const runB = decodePreview(file, { tier: 'phone', createWorker: () => b });
    b.crash('out of memory');
    await expect(runB).rejects.toThrow('preview worker crashed: out of memory');
    expect(b.terminated).toBe(true);
  });

  it('terminates on abort and closes bitmaps that land afterwards', async () => {
    const ctrl = new AbortController();
    const w = new FakeWorker();
    const run = decodePreview(file, { tier: 'phone', signal: ctrl.signal, createWorker: () => w });
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.terminated).toBe(true);

    const late = result();
    w.reply({ type: 'done', result: late });
    expect((late.source.patches[0]?.image as ImageBitmap).close).toHaveBeenCalledOnce();
  });

  it('never starts a worker when already aborted', async () => {
    const createWorker = vi.fn(() => new FakeWorker());
    await expect(
      decodePreview(file, { tier: 'phone', signal: AbortSignal.abort(), createWorker }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createWorker).not.toHaveBeenCalled();
  });
});

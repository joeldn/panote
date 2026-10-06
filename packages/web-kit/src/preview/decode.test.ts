import { describe, expect, it, vi } from 'vitest';

import { pngHeaderFile } from '../__fixtures__/helpers.js';
import {
  browserDecodeEnv,
  closePreview,
  decodePreviewImage,
  supportsDecodeResize,
  type DecodeEnv,
} from './decode.js';

class FakeBitmap {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly from = 'decode',
  ) {}
  close() {
    this.closed = true;
  }
}

interface FakeOptions {
  /** The browser honours resizeWidth/resizeHeight. */
  resize?: boolean;
  /** The probe looks fine but the real decode ignores the resize. */
  resizeLies?: boolean;
  canvas?: boolean;
  webp?: boolean;
  probeThrows?: boolean;
  onCrop?: () => void;
}

function fakeEnv(o: FakeOptions = {}) {
  const { resize = true, canvas = true, webp = true } = o;
  const bitmaps: FakeBitmap[] = [];
  const draws: Array<{ w: number; h: number; src: FakeBitmap }> = [];
  const encodes: string[] = [];
  const make = (w: number, h: number, from?: string) => {
    const b = new FakeBitmap(w, h, from);
    bitmaps.push(b);
    return b;
  };

  const createImageBitmap = vi.fn(async (src: unknown, ...args: unknown[]) => {
    if (src instanceof FakeBitmap) {
      o.onCrop?.();
      return make(args[2] as number, args[3] as number, 'crop');
    }
    const blob = src as Blob;
    const opts = args[0] as ImageBitmapOptions | undefined;
    const probe = blob.size === 68;
    if (probe && o.probeThrows) throw new TypeError('bad options');
    const honoured = resize && (probe || !o.resizeLies);
    if (opts?.resizeWidth && honoured) return make(opts.resizeWidth, opts.resizeHeight ?? 0);
    if (probe) return make(2, 2);
    const head = new DataView(await blob.slice(16, 24).arrayBuffer());
    return make(head.getUint32(0), head.getUint32(4), 'full');
  });

  const createCanvas = (width: number, height: number) => {
    const c = {
      width,
      height,
      getContext: () => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage: (src: FakeBitmap, _x: number, _y: number, w: number, h: number) =>
          draws.push({ w, h, src }),
      }),
      transferToImageBitmap: () => make(c.width, c.height, 'canvas'),
      convertToBlob: async ({ type }: { type: string }) => {
        const out = webp || type !== 'image/webp' ? type : 'image/png';
        encodes.push(`${type}->${out}@${c.width}x${c.height}`);
        return new Blob(['x'], { type: out });
      },
    };
    return c as unknown as OffscreenCanvas;
  };

  const env: DecodeEnv = {
    createImageBitmap: createImageBitmap as unknown as DecodeEnv['createImageBitmap'],
    createCanvas: canvas ? createCanvas : undefined,
    now: () => 0,
  };
  const fileCalls = () =>
    createImageBitmap.mock.calls.filter(([s]) => s instanceof Blob && s.size !== 68);
  return { env, bitmaps, draws, encodes, fileCalls };
}

const live = (bitmaps: FakeBitmap[]) => bitmaps.filter((b) => !b.closed);

describe('supportsDecodeResize', () => {
  it('is true only when the probe comes back at the requested size', async () => {
    expect(await supportsDecodeResize(fakeEnv({ resize: true }).env)).toBe(true);
    expect(await supportsDecodeResize(fakeEnv({ resize: false }).env)).toBe(false);
    expect(await supportsDecodeResize(fakeEnv({ probeThrows: true }).env)).toBe(false);
  });

  it('closes the probe bitmap', async () => {
    const f = fakeEnv();
    await supportsDecodeResize(f.env);
    expect(f.bitmaps).toHaveLength(1);
    expect(live(f.bitmaps)).toEqual([]);
  });
});

describe('decodePreviewImage', () => {
  it('resizes at decode time on desktop and splits into patches', async () => {
    const f = fakeEnv();
    const out = await decodePreviewImage(pngHeaderFile(17000, 8500), { tier: 'desktop' }, f.env);

    expect(f.fileCalls()).toHaveLength(1);
    expect(f.fileCalls()[0]?.[1]).toEqual({
      resizeWidth: 8192,
      resizeHeight: 4096,
      resizeQuality: 'high',
    });
    expect(out?.source.width).toBe(8192);
    expect(out?.source.height).toBe(4096);
    expect(out?.source.patches.map(({ x, w }) => [x, w])).toEqual([
      [0, 2733],
      [2729, 2734],
      [5459, 2733],
    ]);
    expect(out?.stats).toMatchObject({ sourceWidth: 17000, sourceHeight: 8500, resize: 'decode' });
    // Only the patches survive; the whole-preview bitmap is closed once cropped.
    expect(live(f.bitmaps)).toEqual(out?.source.patches.map((p) => p.image));
    expect(f.draws.some((d) => d.w === 8192)).toBe(false);
  });

  it('encodes a 4096-wide WebP stash', async () => {
    const f = fakeEnv();
    const out = await decodePreviewImage(pngHeaderFile(17000, 8500), { tier: 'desktop' }, f.env);
    expect(f.encodes).toEqual(['image/webp->image/webp@4096x2048']);
    expect(out?.stash?.type).toBe('image/webp');
  });

  it('skips the stash encode when asked (a re-decode of a stash)', async () => {
    const f = fakeEnv();
    const out = await decodePreviewImage(
      pngHeaderFile(4096, 2048),
      { tier: 'desktop', stash: false },
      f.env,
    );
    expect(f.encodes).toEqual([]);
    expect(out?.stash).toBeNull();
    expect(out?.source.width).toBe(4096);
  });

  it('falls back to JPEG where WebP encoding is unsupported', async () => {
    const f = fakeEnv({ webp: false });
    const out = await decodePreviewImage(pngHeaderFile(8000, 4000), { tier: 'phone' }, f.env);
    expect(f.encodes).toEqual([
      'image/webp->image/png@4096x2048',
      'image/jpeg->image/jpeg@4096x2048',
    ]);
    expect(out?.stash?.type).toBe('image/jpeg');
  });

  it('falls back to a canvas downscale without decode-time resize', async () => {
    const f = fakeEnv({ resize: false });
    const out = await decodePreviewImage(pngHeaderFile(12000, 6000), { tier: 'desktop' }, f.env);

    expect(f.fileCalls()[0]?.[1]).toBeUndefined();
    expect(f.draws[0]).toMatchObject({ w: 8192, h: 4096, src: { width: 12000, from: 'full' } });
    expect(out?.stats.resize).toBe('canvas');
    expect(f.bitmaps.find((b) => b.from === 'full')?.closed).toBe(true);
    expect(live(f.bitmaps)).toHaveLength(3);
  });

  it('falls back to the canvas when the probe passes but the decode ignores resize', async () => {
    const f = fakeEnv({ resizeLies: true });
    const out = await decodePreviewImage(pngHeaderFile(12000, 6000), { tier: 'desktop' }, f.env);
    expect(out?.stats.resize).toBe('canvas');
    expect(out?.source.width).toBe(8192);
  });

  it('skips big images on a phone without decode-time resize', async () => {
    const f = fakeEnv({ resize: false });
    expect(
      await decodePreviewImage(pngHeaderFile(12000, 6000), { tier: 'phone' }, f.env),
    ).toBeNull();
    expect(f.fileCalls()).toEqual([]);
  });

  it('still previews a phone image under the cutoff without resize', async () => {
    const f = fakeEnv({ resize: false });
    const out = await decodePreviewImage(pngHeaderFile(10000, 5000), { tier: 'phone' }, f.env);
    expect(out?.stats.resize).toBe('canvas');
    expect(out?.source.patches).toHaveLength(1);
    expect(out?.source.patches[0]).toMatchObject({ x: 0, y: 0, w: 4096, h: 2048 });
  });

  it('skips when it would need a canvas and there is none', async () => {
    const f = fakeEnv({ resize: false, canvas: false });
    expect(
      await decodePreviewImage(pngHeaderFile(12000, 6000), { tier: 'desktop' }, f.env),
    ).toBeNull();
    expect(f.fileCalls()).toEqual([]);
  });

  it('works without a canvas when decode-time resize does the work, minus the stash', async () => {
    const f = fakeEnv({ canvas: false });
    const out = await decodePreviewImage(pngHeaderFile(12000, 6000), { tier: 'phone' }, f.env);
    expect(out?.source.width).toBe(4096);
    expect(out?.stash).toBeNull();
  });

  it('decodes a small image as-is and hands the bitmap over as the one patch', async () => {
    const f = fakeEnv();
    const out = await decodePreviewImage(pngHeaderFile(4000, 2000), { tier: 'phone' }, f.env);
    expect(f.fileCalls()[0]?.[1]).toBeUndefined();
    expect(out?.stats.resize).toBe('none');
    expect(out?.source.patches[0]?.image).toBe(f.bitmaps.find((b) => b.from === 'full'));
    expect(live(f.bitmaps)).toHaveLength(1);
  });

  it('keeps patches within MAX_TEXTURE_SIZE', async () => {
    const f = fakeEnv();
    const out = await decodePreviewImage(
      pngHeaderFile(17000, 8500),
      { tier: 'desktop', limits: { maxTextureSize: 2048 } },
      f.env,
    );
    const patches = out?.source.patches ?? [];
    expect(patches.length).toBeGreaterThan(6);
    for (const p of patches) expect(Math.max(p.w, p.h)).toBeLessThanOrEqual(2048);
  });

  it('returns null for an unreadable header', async () => {
    const f = fakeEnv();
    const junk = new Blob([new Uint8Array(64)]);
    expect(await decodePreviewImage(junk, { tier: 'desktop' }, f.env)).toBeNull();
  });

  it('closes every bitmap it made when aborted mid-way', async () => {
    const ctrl = new AbortController();
    let crops = 0;
    const f = fakeEnv({ onCrop: () => (++crops === 2 ? ctrl.abort() : undefined) });
    const run = decodePreviewImage(
      pngHeaderFile(17000, 8500),
      { tier: 'desktop' },
      f.env,
      ctrl.signal,
    );
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.bitmaps.length).toBeGreaterThan(2);
    expect(live(f.bitmaps)).toEqual([]);
  });

  it('does nothing once aborted before it starts', async () => {
    const f = fakeEnv();
    const run = decodePreviewImage(
      pngHeaderFile(17000, 8500),
      { tier: 'desktop' },
      f.env,
      AbortSignal.abort(),
    );
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.bitmaps).toEqual([]);
  });
});

describe('closePreview', () => {
  it('closes bitmaps and empties canvases', () => {
    const bitmap = new FakeBitmap(2, 2);
    const canvas = { width: 2, height: 2 };
    closePreview({
      width: 4,
      height: 2,
      patches: [
        { x: 0, y: 0, w: 2, h: 2, image: bitmap as unknown as ImageBitmap },
        { x: 2, y: 0, w: 2, h: 2, image: canvas as unknown as OffscreenCanvas },
      ],
    });
    expect(bitmap.closed).toBe(true);
    expect(canvas).toEqual({ width: 0, height: 0 });
  });
});

describe('browserDecodeEnv', () => {
  it('wires createImageBitmap and OffscreenCanvas when present', () => {
    class Canvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
    }
    const g = {
      createImageBitmap: vi.fn(),
      OffscreenCanvas: Canvas as unknown as typeof OffscreenCanvas,
    };
    const env = browserDecodeEnv(g);
    expect(env.createCanvas?.(3, 4)).toEqual(new Canvas(3, 4));
    void env.createImageBitmap(new Blob([]));
    expect(g.createImageBitmap).toHaveBeenCalledOnce();
  });

  it('leaves createCanvas unset without OffscreenCanvas', () => {
    expect(browserDecodeEnv({ createImageBitmap: vi.fn() }).createCanvas).toBeUndefined();
  });
});

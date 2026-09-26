import { describe, expect, it, vi } from 'vitest';
import { uploadDir } from './r2io.js';

describe('uploadDir', () => {
  it('uploads every tile under tilePrefix, in file order', async () => {
    const order: string[] = [];
    const put = vi.fn(async (key: string) => {
      order.push(key);
    });
    await uploadDir(
      {
        '0/px/0-0.webp': new Uint8Array(),
        '0/nx/0-0.webp': new Uint8Array(),
      },
      'tiles/p1/v1/',
      put,
    );
    expect(order).toEqual(['tiles/p1/v1/0/px/0-0.webp', 'tiles/p1/v1/0/nx/0-0.webp']);
  });

  it('never uploads manifest.json, even when present in files - the manifest is handled by the caller', async () => {
    const put = vi.fn(async () => {});
    await uploadDir(
      {
        '0/px/0-0.webp': new Uint8Array(),
        'manifest.json': new Uint8Array(),
      },
      'tiles/p2/v1/',
      put,
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('tiles/p2/v1/0/px/0-0.webp', expect.anything(), 'image/webp');
  });

  it('picks content-type by extension: .json, .webp, and other', async () => {
    const calls: Array<{ key: string; contentType: string }> = [];
    const put = vi.fn(async (key: string, _body: Uint8Array, contentType: string) => {
      calls.push({ key, contentType });
    });
    await uploadDir(
      {
        'level0/0-0.webp': new Uint8Array(),
        'other.bin': new Uint8Array(),
        'sub/data.json': new Uint8Array(),
      },
      'tiles/p3/v1/',
      put,
    );
    expect(calls).toEqual([
      { key: 'tiles/p3/v1/level0/0-0.webp', contentType: 'image/webp' },
      { key: 'tiles/p3/v1/other.bin', contentType: 'application/octet-stream' },
      { key: 'tiles/p3/v1/sub/data.json', contentType: 'application/json' },
    ]);
  });
});

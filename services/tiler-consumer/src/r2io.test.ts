import { describe, expect, it, vi } from 'vitest';
import { uploadDir } from './r2io.js';

describe('uploadDir', () => {
  it('uploads manifest.json LAST', async () => {
    const order: string[] = [];
    const put = vi.fn(async (key: string) => {
      order.push(key);
    });
    await uploadDir(
      {
        '0/px/0-0.webp': new Uint8Array(),
        'manifest.json': new Uint8Array(),
        '0/nx/0-0.webp': new Uint8Array(),
      },
      'panos/u/p1/',
      put,
    );
    expect(order[order.length - 1]).toBe('panos/u/p1/manifest.json');
  });

  it('skips manifest.json entirely when absent', async () => {
    const order: string[] = [];
    const put = vi.fn(async (key: string) => {
      order.push(key);
    });
    await uploadDir(
      {
        '0/px/0-0.webp': new Uint8Array(),
        '0/nx/0-0.webp': new Uint8Array(),
      },
      'panos/u/p2/',
      put,
    );
    expect(order).toEqual(['panos/u/p2/0/px/0-0.webp', 'panos/u/p2/0/nx/0-0.webp']);
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
        'manifest.json': new Uint8Array(),
      },
      'panos/u/p3/',
      put,
    );
    expect(calls).toEqual([
      { key: 'panos/u/p3/level0/0-0.webp', contentType: 'image/webp' },
      { key: 'panos/u/p3/other.bin', contentType: 'application/octet-stream' },
      { key: 'panos/u/p3/manifest.json', contentType: 'application/json' },
    ]);
  });
});

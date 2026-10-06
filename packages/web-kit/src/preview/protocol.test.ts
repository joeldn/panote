import { describe, expect, it, vi } from 'vitest';

import { pngHeaderFile } from '../__fixtures__/helpers.js';
import type { DecodeEnv } from './decode.js';
import { runDecodeJob } from './protocol.js';

const bitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe('runDecodeJob', () => {
  it('replies done and transfers every patch bitmap', async () => {
    const env: DecodeEnv = {
      createImageBitmap: vi.fn(async () => bitmap(4000, 2000)) as DecodeEnv['createImageBitmap'],
    };
    const file = pngHeaderFile(4000, 2000);
    const { response, transfer } = await runDecodeJob(
      { type: 'decode', file, request: { tier: 'phone' } },
      env,
    );
    expect(response.type).toBe('done');
    const patches = response.type === 'done' ? (response.result?.source.patches ?? []) : [];
    expect(patches).toHaveLength(1);
    expect(transfer).toEqual(patches.map((p) => p.image));
  });

  it('replies done with null and transfers nothing when skipped', async () => {
    const env: DecodeEnv = { createImageBitmap: vi.fn() as DecodeEnv['createImageBitmap'] };
    const junk = new Blob([new Uint8Array(32)]);
    expect(
      await runDecodeJob({ type: 'decode', file: junk, request: { tier: 'phone' } }, env),
    ).toEqual({ response: { type: 'done', result: null }, transfer: [] });
  });

  it('turns a thrown decode into an error reply', async () => {
    const env: DecodeEnv = {
      createImageBitmap: vi.fn(async () => {
        throw new Error('corrupt JPEG');
      }) as DecodeEnv['createImageBitmap'],
    };
    const res = await runDecodeJob(
      { type: 'decode', file: pngHeaderFile(100, 50), request: { tier: 'phone' } },
      env,
    );
    expect(res).toEqual({ response: { type: 'error', message: 'corrupt JPEG' }, transfer: [] });
  });
});

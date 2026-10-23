import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordOps } from './ops-events.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordOps', () => {
  it('writes the event, its detail, the service and one number', () => {
    const writeDataPoint = vi.fn();
    recordOps({ writeDataPoint }, 'tiler-consumer', { event: 'tile-ok', value: 93_000 });
    recordOps({ writeDataPoint }, 'upload-api', {
      event: 'upload-refused',
      detail: 'x'.repeat(100),
      value: Number.NaN,
    });
    expect(writeDataPoint.mock.calls).toEqual([
      [{ indexes: ['tile-ok'], blobs: ['tile-ok', '', 'tiler-consumer', 'o1'], doubles: [93_000] }],
      [
        {
          indexes: ['upload-refused'],
          blobs: ['upload-refused', 'x'.repeat(64), 'upload-api', 'o1'],
          doubles: [0],
        },
      ],
    ]);
  });

  it('does nothing without a binding, and never throws', () => {
    expect(() => recordOps(undefined, 'admin-api', { event: 'tour-created' })).not.toThrow();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      writeDataPoint: () => {
        throw new Error('quota');
      },
    };
    expect(() => recordOps(broken, 'admin-api', { event: 'tour-created' })).not.toThrow();
    expect(log).toHaveBeenCalledWith('ops event not written:', 'Error');
  });
});

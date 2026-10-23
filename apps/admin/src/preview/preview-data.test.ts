import type { TourWithConfigsOk } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import { fromServer } from '../editor/model.js';
import { previewData } from './preview-data.js';

const saved: TourWithConfigsOk = {
  tour: {
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'a' }, { panoId: 'b' }, { panoId: 'c' }],
  },
  etag: 'te',
  configs: {
    a: { config: { panoId: 'a', title: 'Square', hotspots: [] }, etag: 'ea' },
    b: { missing: true, deleting: false, hasOriginal: true },
    c: { missing: true, deleting: true, hasOriginal: false },
  },
};

describe('previewData', () => {
  it('shows the editor’s documents as they stand, unsaved edits included', () => {
    const docs = fromServer(saved);
    const a = docs.scenes.a;
    if (a?.kind !== 'config') throw new Error('expected a config');
    a.current = { ...a.current, title: 'Main square' };
    const data = previewData(docs, null);
    expect(data.configs.a).toEqual({
      config: { panoId: 'a', title: 'Main square', hotspots: [] },
      etag: 'ea',
    });
    expect(data.tour.title).toBe('Old town');
    expect(data.publish).toBeNull();
  });

  it('leaves out an untitled upload no Save has written, as visitors would', () => {
    const data = previewData(fromServer(saved), null);
    expect(data.configs.b).toEqual({ missing: true, deleting: false, hasOriginal: true });
    expect(data.configs.c).toEqual({ missing: true, deleting: true, hasOriginal: false });
  });

  it('shows an untitled upload once it has been given a name', () => {
    const docs = fromServer(saved);
    const b = docs.scenes.b;
    if (b?.kind !== 'config') throw new Error('expected a config');
    b.current = { ...b.current, title: 'Church' };
    expect(previewData(docs, null).configs.b).toEqual({
      config: { panoId: 'b', title: 'Church', hotspots: [] },
      etag: '',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { coverUrl } from './cover.js';
import { formatCount, relativeTime } from './format.js';
import { copyTitle } from './use-dashboard.js';

describe('dashboard formatting', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [4449, '4.4k'],
    [18_200, '18k'],
    [1_250_000, '1.2M'],
  ])('formatCount(%i) = %s', (n, out) => expect(formatCount(n)).toBe(out));

  it('formats relative update times', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(relativeTime('2026-10-01T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-01T11:55:00Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-09-29T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime('not a date', now)).toBe('a while ago');
  });

  it('caps a duplicate title at the schema limit', () => {
    expect(copyTitle('Town')).toBe('Town (copy)');
    expect(copyTitle('x'.repeat(200))).toHaveLength(200);
  });

  it('builds no cover for a tombstoned or untiled pano', () => {
    const base = {
      panoId: 'p1',
      title: null,
      hasConfig: true,
      hasOriginal: true,
      updatedAt: '',
    } as const;
    const manifest = { format: 'webp', tileSize: 512 } as const;
    expect(coverUrl('t/', undefined)).toBeNull();
    expect(coverUrl('t/', { ...base, deleting: true, tiling: 'ready', manifest })).toBeNull();
    expect(
      coverUrl('t/', { ...base, deleting: false, tiling: 'pending', manifest: null }),
    ).toBeNull();
    expect(coverUrl('t/', { ...base, deleting: false, tiling: 'ready', manifest })).toBe(
      't/p1/0/pz/0-0.webp',
    );
  });
});

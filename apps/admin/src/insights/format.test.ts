import { describe, expect, it } from 'vitest';

import { formatDay, formatDuration } from './format.js';

describe('insights formatting', () => {
  it.each([
    [0, '0s'],
    [44_600, '45s'],
    [134_000, '2m 14s'],
    [3_599_000, '59m 59s'],
    [3_900_000, '1h 5m'],
  ])('formatDuration(%i) = %s', (ms, out) => expect(formatDuration(ms)).toBe(out));

  it('formats UTC days without shifting them', () => {
    expect(formatDay('2026-09-18')).toBe('18 Sep');
    expect(formatDay('2026-10-01')).toBe('1 Oct');
  });
});

import { describe, expect, it } from 'vitest';

import {
  formatMs,
  formatPercent,
  formatPoint,
  formatSize,
  formatTime,
  formatUsage,
} from './format.js';

describe('ops formatting', () => {
  it('sizes from bytes up', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(4096)).toBe('4 KB');
    expect(formatSize(5 * 1024 ** 2)).toBe('5 MB');
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  it('durations, rates and times', () => {
    expect(formatMs(1.53)).toBe('1.5 ms');
    expect(formatMs(250)).toBe('250 ms');
    expect(formatMs(5250)).toBe('5.3 s');
    expect(formatMs(150_000)).toBe('2.5 min');
    expect(formatPercent(5, 1000)).toBe('0.5%');
    expect(formatPercent(1, 0)).toBe('—');
    expect(formatTime('2026-10-23T03:07:00.000Z')).toBe('Oct 23, 03:07');
    expect(formatPoint('2026-10-23T09:00:00.000Z', 'hour')).toBe('09:00');
    expect(formatPoint('2026-10-20T00:00:00.000Z', 'day')).toBe('Oct 20');
  });

  it('usage units', () => {
    expect(formatUsage(9_000_000, 'count')).toBe('9,000,000');
    expect(formatUsage(42, 'seconds')).toBe('42 s');
    expect(formatUsage(22_500, 'seconds')).toBe('375 min');
    expect(formatUsage(25 * 2 ** 30 * 3600, 'byte-seconds')).toBe('25 GiB-h');
    expect(formatUsage(10e9, 'bytes')).toBe('10 GB');
    expect(formatUsage(6.004e9, 'bytes')).toBe('6 GB');
    expect(formatUsage(340e6, 'bytes')).toBe('340 MB');
  });
});

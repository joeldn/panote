import { describe, expect, it } from 'vitest';
import {
  CDN_PURGE_FAILURE_KEY,
  CdnPurgeFailureSchema,
  CRON_STATUS_KEY,
  CronStatusSchema,
} from './ops.js';

describe('ops markers', () => {
  it('live under ops/, which the CDN never serves', () => {
    for (const key of [CRON_STATUS_KEY, CDN_PURGE_FAILURE_KEY]) {
      expect(key.startsWith('ops/')).toBe(true);
    }
  });

  it('parse what their writers store', () => {
    expect(
      CronStatusSchema.safeParse({ lastRunAt: 'x', lastOkAt: null, failed: ['tile-gc'] }).success,
    ).toBe(true);
    expect(CronStatusSchema.safeParse({ lastRunAt: 'x', failed: [] }).success).toBe(false);
    expect(CdnPurgeFailureSchema.safeParse({ at: 'x', detail: 'HTTP 429' }).success).toBe(true);
    expect(CdnPurgeFailureSchema.safeParse({ at: 1, detail: 'HTTP 429' }).success).toBe(false);
  });
});

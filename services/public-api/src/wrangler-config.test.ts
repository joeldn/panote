// The limiter's `period` lives in wrangler.jsonc, the 429's Retry-After in code:
// this keeps the two from drifting apart.
import { parseJsonc } from '@internal/worker-kit/testing';
import { describe, expect, it } from 'vitest';

import wrangler from '../wrangler.jsonc?raw';
import { RATE_PERIOD_SECONDS } from './index.js';

type Config = {
  env: Record<string, { ratelimits?: { name: string; simple: { period: number } }[] }>;
};
const config = parseJsonc(wrangler) as Config;

describe('wrangler.jsonc ratelimits', () => {
  it.each(['dev', 'production'])('%s: every limiter period is RATE_PERIOD_SECONDS', (env) => {
    const limiters = config.env[env]?.ratelimits ?? [];
    expect(limiters.map((l) => l.name).sort()).toEqual([
      'EVENTS_LIMITER',
      'LIKE_LIMITER',
      'VIEW_LIMITER',
    ]);
    for (const l of limiters)
      expect([l.name, l.simple.period]).toEqual([l.name, RATE_PERIOD_SECONDS]);
  });
});

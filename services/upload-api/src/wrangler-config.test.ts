// The limiter's `period` lives in wrangler.jsonc, the 429's Retry-After in code:
// this keeps the two from drifting apart.
import { parseJsonc } from '@internal/worker-kit/testing';
import { describe, expect, it } from 'vitest';

import wrangler from '../wrangler.jsonc?raw';
import { UPLOAD_URL_RATE_PERIOD_SECONDS } from './index.js';

type Config = {
  env: Record<string, { ratelimits?: { name: string; simple: { period: number } }[] }>;
};
const config = parseJsonc(wrangler) as Config;

describe('wrangler.jsonc ratelimits', () => {
  it.each(['dev', 'production'])(
    '%s: UPLOAD_URL_LIMITER period is UPLOAD_URL_RATE_PERIOD_SECONDS',
    (env) => {
      const limiters = config.env[env]?.ratelimits ?? [];
      expect(limiters.map((l) => [l.name, l.simple.period])).toEqual([
        ['UPLOAD_URL_LIMITER', UPLOAD_URL_RATE_PERIOD_SECONDS],
      ]);
    },
  );
});

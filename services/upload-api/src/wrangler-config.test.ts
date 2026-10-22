// The limiter's `period` lives in wrangler.jsonc, the 429's Retry-After in code:
// this keeps the two from drifting apart.
import { parseJsonc } from '@internal/worker-kit/testing';
import { describe, expect, it } from 'vitest';

import wrangler from '../wrangler.jsonc?raw';
import { UPLOAD_URL_RATE_PERIOD_SECONDS } from './index.js';

type Config = {
  env: Record<
    string,
    {
      ratelimits?: { name: string; simple: { period: number } }[];
      vars?: Record<string, string>;
    }
  >;
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

// The caps in docs/deploy.md (Owner quotas): the same in every env.
describe('wrangler.jsonc owner quotas', () => {
  it.each(['dev', 'production'])('%s sets every quota var', (env) => {
    const vars = config.env[env]?.vars ?? {};
    expect({
      MAX_PANOS_PER_OWNER: vars.MAX_PANOS_PER_OWNER,
      MAX_BYTES_PER_OWNER: vars.MAX_BYTES_PER_OWNER,
      MAX_UPLOADS_PER_OWNER_PER_DAY: vars.MAX_UPLOADS_PER_OWNER_PER_DAY,
    }).toEqual({
      MAX_PANOS_PER_OWNER: '500',
      MAX_BYTES_PER_OWNER: String(20 * 1024 ** 3),
      MAX_UPLOADS_PER_OWNER_PER_DAY: '50',
    });
  });
});

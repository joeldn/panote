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
      durable_objects?: { bindings: { name: string; class_name: string }[] };
      migrations?: { tag: string; new_sqlite_classes?: string[] }[];
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

// The global daily ceiling (src/ceiling.ts, docs/deploy.md Owner quotas): its DO and its
// limits in every env, since Wrangler inherits neither into a named env.
describe('wrangler.jsonc global upload ceiling', () => {
  it.each(['dev', 'production'])('%s binds UploadCeiling and sets both limits', (env) => {
    const e = config.env[env];
    expect(e?.durable_objects?.bindings).toEqual([
      { name: 'UPLOAD_CEILING', class_name: 'UploadCeiling' },
    ]);
    expect(e?.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['UploadCeiling'] }]);
    expect({
      MAX_UPLOADS_PER_DAY_GLOBAL: e?.vars?.MAX_UPLOADS_PER_DAY_GLOBAL,
      MAX_UPLOAD_BYTES_PER_DAY_GLOBAL: e?.vars?.MAX_UPLOAD_BYTES_PER_DAY_GLOBAL,
    }).toEqual({
      MAX_UPLOADS_PER_DAY_GLOBAL: '2000',
      MAX_UPLOAD_BYTES_PER_DAY_GLOBAL: String(200 * 1024 ** 3),
    });
  });
});

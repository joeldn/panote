import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { loadCacheRules, loadCorsRules } from './rules.js';

// A stand-in for infra/, with the same cloudflare/ and r2/ subdirectories.
const scratch = mkdtempSync(join(tmpdir(), 'panote-infra-rules-'));
const scratchUrl = pathToFileURL(`${scratch}/`);
mkdirSync(join(scratch, 'cloudflare'));
mkdirSync(join(scratch, 'r2'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fixtures = 0;
function fixture(dir: 'cloudflare' | 'r2', json: unknown): string {
  const name = `fixture-${(fixtures += 1)}.json`;
  writeFileSync(join(scratch, dir, name), JSON.stringify(json));
  return name;
}
const cacheRules = (json: unknown, zone = 'panote.dev') =>
  loadCacheRules(fixture('cloudflare', json), zone, scratchUrl);
const corsRules = (json: unknown) => loadCorsRules(fixture('r2', json), scratchUrl);

const RULE = {
  ref: 'r',
  expression: '(http.host eq "cdn.panote.dev")',
  action: 'set_cache_settings',
  action_parameters: { edge_ttl: { mode: 'respect_origin', default: 60 } },
};

describe('loadCacheRules', () => {
  it('converts the API shape and defaults enabled to true', () => {
    expect(cacheRules({ rules: [RULE] })).toEqual([
      {
        ref: 'r',
        expression: RULE.expression,
        action: 'set_cache_settings',
        enabled: true,
        actionParameters: { edgeTtl: { mode: 'respect_origin', default: 60, statusCodeTtls: [] } },
      },
    ]);
  });

  it("refuses the other environment's file", () => {
    expect(() => loadCacheRules('cache-rules.dev.json', 'panote.io')).toThrow(
      /must match http.host eq "cdn.panote.io"/,
    );
  });

  it.each([
    ['no rules array', { rules: {} }, /no rules array/],
    ['an unknown top-level key', { rules: [], zoneId: 'x' }, /unsupported key\(s\) zoneId/],
    ['a rule that is not an object', { rules: [1] }, /not an object/],
    ['an unknown rule key', { rules: [{ ...RULE, position: 1 }] }, /position/],
    ['a missing ref', { rules: [{ ...RULE, ref: '' }] }, /needs a ref/],
    ['another action', { rules: [{ ...RULE, action: 'block' }] }, /action block/],
    ['no parameters', { rules: [{ ...RULE, action_parameters: undefined }] }, /action_parameters/],
    [
      'an unknown parameter',
      { rules: [{ ...RULE, action_parameters: { browser_ttl: {} } }] },
      /browser_ttl/,
    ],
    ['a bad edge_ttl', { rules: [{ ...RULE, action_parameters: { edge_ttl: {} } }] }, /edge_ttl/],
    [
      'a bad status_code_ttl',
      {
        rules: [{ ...RULE, action_parameters: { edge_ttl: { mode: 'm', status_code_ttl: {} } } }],
      },
      /status_code_ttl/,
    ],
    [
      'a status_code_ttl range',
      {
        rules: [
          {
            ...RULE,
            action_parameters: { edge_ttl: { mode: 'm', status_code_ttl: [{ value: 1 }] } },
          },
        ],
      },
      /need status_code and value/,
    ],
  ])('refuses %s', (_, json, error) => {
    expect(() => cacheRules(json)).toThrow(error);
  });
});

describe('loadCorsRules', () => {
  it('reads both committed files', () => {
    expect(loadCorsRules('cors.json')).toHaveLength(2);
    expect(JSON.stringify(loadCorsRules('cors.dev.json'))).toContain('http://localhost:5173');
  });

  it('keeps a rule without headers or max age', () => {
    expect(
      corsRules({ rules: [{ allowed: { origins: ['https://a'], methods: ['GET'] } }] }),
    ).toEqual([{ allowed: { origins: ['https://a'], methods: ['GET'] } }]);
  });

  it.each([
    ['no rules array', {}, /no rules array/],
    ['no allowed block', { rules: [{}] }, /no allowed block/],
    [
      'an S3-style key',
      { rules: [{ allowed: { origins: [], methods: [] }, AllowedHeaders: [] }] },
      /AllowedHeaders/,
    ],
    ['a non-string origin', { rules: [{ allowed: { origins: [1], methods: [] } }] }, /origins/],
    [
      'a string max age',
      { rules: [{ allowed: { origins: [], methods: [] }, maxAgeSeconds: '1' }] },
      /maxAgeSeconds/,
    ],
  ])('refuses %s', (_, json, error) => {
    expect(() => corsRules(json)).toThrow(error);
  });
});

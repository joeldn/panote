import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { RESOURCES, type ResourceKey } from './names.js';
import type { Infra } from './infra.js';
import type { Settings } from './settings.js';
import {
  inputsOf,
  installMocks,
  run,
  stackSettings,
  ZONE_IDS,
  type Registered,
} from './test-support.js';

beforeAll(installMocks);

interface Rule {
  ref?: string;
  expression: string;
  action: string;
  ratelimit?: Record<string, unknown>;
  actionParameters?: Record<string, unknown>;
}

function rulesOf(resources: Map<string, Registered>, key: ResourceKey, phase: string): Rule[] {
  const inputs = inputsOf(resources, key);
  expect(inputs.phase).toBe(phase);
  expect(inputs.kind).toBe('zone');
  return inputs.rules as Rule[];
}

describe.each([
  ['dev', 'panote.dev', '-dev'],
  ['production', 'panote.io', ''],
] as const)('the %s stack', (stack, zone, suffix) => {
  const settings = stackSettings(stack);
  let resources: Map<string, Registered>;
  let infra: Infra;
  beforeAll(async () => {
    ({ resources, infra } = await run(settings));
  });

  it('names every resource for its environment', () => {
    expect(inputsOf(resources, 'bucket').name).toBe(`pano-content${suffix}`);
    expect(inputsOf(resources, 'uploadsQueue').queueName).toBe(`pano-uploads${suffix}`);
    expect(inputsOf(resources, 'deadLetterQueue').queueName).toBe(`pano-uploads-dlq${suffix}`);
    expect(inputsOf(resources, 'cdnDomain').domain).toBe(`cdn.${zone}`);
    expect(inputsOf(resources, 'cdnDomain').zoneId).toBe(ZONE_IDS[zone]);
  });

  it('creates the bucket with its location hint (production only)', () => {
    expect(inputsOf(resources, 'bucket').location).toBe(
      stack === 'production' ? 'enam' : undefined,
    );
  });

  it('keeps messages for the maximum 14 days', () => {
    for (const key of ['uploadsQueue', 'deadLetterQueue'] as const) {
      expect(inputsOf(resources, key).settings).toEqual({ messageRetentionPeriod: 1209600 });
    }
  });

  it('loads bucket CORS from infra/r2/cors.json', () => {
    const file = JSON.parse(
      readFileSync(new URL('../../r2/cors.json', import.meta.url), 'utf8'),
    ) as { rules: unknown[] };
    expect(inputsOf(resources, 'bucketCors').rules).toEqual(file.rules);
    expect(JSON.stringify(file)).not.toContain('localhost');
  });

  it('turns the r2.dev URL off', () => {
    expect(inputsOf(resources, 'managedDomain').enabled).toBe(false);
  });

  it('queues a message for each original uploaded under panos/', () => {
    const inputs = inputsOf(resources, 'uploadNotification');
    expect(inputs.queueId).toBe(`${RESOURCES.uploadsQueue.name}-queue-id`);
    expect(inputs.rules).toEqual([
      {
        actions: ['PutObject', 'CopyObject', 'CompleteMultipartUpload'],
        prefix: 'panos/',
        suffix: '/original',
      },
    ]);
  });

  it('blocks private prefixes and query strings on the CDN', () => {
    const rules = rulesOf(resources, 'wafRuleset', 'http_request_firewall_custom');
    expect(rules.map(({ expression, action }) => ({ expression, action }))).toEqual([
      {
        expression: `(http.host eq "cdn.${zone}" and not (starts_with(http.request.uri.path, "/tiles/") or starts_with(http.request.uri.path, "/pub/") or starts_with(http.request.uri.path, "/slugs/")))`,
        action: 'block',
      },
      {
        expression: `(http.host eq "cdn.${zone}" and http.request.uri.query ne "")`,
        action: 'block',
      },
    ]);
  });

  it('rate-limits /api/ and /s/ within the Free plan', () => {
    const [rule, ...rest] = rulesOf(resources, 'rateLimitRuleset', 'http_ratelimit');
    expect(rest).toEqual([]);
    expect(rule?.expression).toBe(
      '(starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/s/"))',
    );
    expect(rule?.action).toBe('block');
    expect(rule?.ratelimit).toEqual({
      characteristics: ['ip.src', 'cf.colo.id'],
      period: 10,
      requestsPerPeriod: 100,
      mitigationTimeout: 10,
    });
  });

  it('takes the cache rules from its own cache-rules file', () => {
    const rules = rulesOf(resources, 'cacheRuleset', 'http_request_cache_settings');
    expect(rules.map((rule) => rule.ref)).toEqual([
      'panote-json-edge-cache',
      'panote-tiles-404-no-store',
    ]);
    for (const rule of rules) expect(rule.expression).toContain(`http.host eq "cdn.${zone}"`);
    expect(rules[0]?.actionParameters).toEqual({
      cache: true,
      edgeTtl: { mode: 'respect_origin', statusCodeTtls: [{ statusCode: 404, value: -1 }] },
    });
  });

  it('sends nosniff and a no-content CSP from the CDN', () => {
    const [cdn] = rulesOf(resources, 'responseHeaderRuleset', 'http_response_headers_transform');
    expect(cdn?.expression).toBe(`(http.host eq "cdn.${zone}")`);
    expect(cdn?.action).toBe('rewrite');
    expect(cdn?.actionParameters).toEqual({
      headers: {
        'X-Content-Type-Options': { operation: 'set', value: 'nosniff' },
        'Content-Security-Policy': { operation: 'set', value: "default-src 'none'; sandbox" },
      },
    });
  });

  it('sets HSTS for a year like the apps, subdomains included, not preloaded', () => {
    const inputs = inputsOf(resources, 'hsts');
    expect(inputs.settingId).toBe('security_header');
    expect(inputs.value).toEqual({
      strict_transport_security: {
        enabled: true,
        max_age: 31536000,
        include_subdomains: true,
        preload: false,
        nosniff: false,
      },
    });
    const appHeaders = readFileSync(
      new URL('../../../packages/web-kit/src/headers.ts', import.meta.url),
      'utf8',
    );
    expect(appHeaders).toContain('max-age=31536000; includeSubDomains');
  });

  it('protects the bucket, both queues and, where declared, the Auth0 API, SPA and Google connection', () => {
    // `__protect` is the SDK's record of the protect option; mocks don't see options.
    const protectedKeys = Object.entries(infra.resources)
      .filter(([, resource]) => (resource as unknown as { __protect?: boolean }).__protect)
      .map(([key]) => key);
    const auth0 = settings.auth0 ? ['api', 'googleConnection', 'spaClient'] : [];
    expect(protectedKeys.sort()).toEqual(
      ['bucket', 'deadLetterQueue', 'uploadsQueue', ...auth0].sort(),
    );
  });

  it('normalizes incoming URLs, which the WAF rule relies on', () => {
    expect(inputsOf(resources, 'urlNormalization')).toMatchObject({
      type: 'cloudflare',
      scope: 'incoming',
    });
  });

  it('points the apex at the Workers routes', () => {
    expect(inputsOf(resources, 'apexRecord')).toMatchObject({
      name: zone,
      type: 'AAAA',
      content: '100::',
      proxied: true,
    });
  });
});

describe('dev only', () => {
  it('marks every response noindex and has no www redirect', async () => {
    const resources = (await run(stackSettings('dev'))).resources;
    const rules = resources.get(RESOURCES.responseHeaderRuleset.name)?.inputs.rules as Rule[];
    expect(rules[1]).toMatchObject({
      expression: 'true',
      action: 'rewrite',
      actionParameters: {
        headers: { 'X-Robots-Tag': { operation: 'set', value: 'noindex, nofollow' } },
      },
    });
    expect(resources.has(RESOURCES.wwwRecord.name)).toBe(false);
    expect(resources.has(RESOURCES.redirectRuleset.name)).toBe(false);
  });
});

describe('production only', () => {
  it('stays indexable and redirects www to the apex', async () => {
    const resources = (await run(stackSettings('production'))).resources;
    const rules = resources.get(RESOURCES.responseHeaderRuleset.name)?.inputs.rules as Rule[];
    expect(rules).toHaveLength(1);
    expect(JSON.stringify(rules)).not.toContain('X-Robots-Tag');
    expect(resources.get(RESOURCES.wwwRecord.name)?.inputs).toMatchObject({
      name: 'www.panote.io',
      type: 'AAAA',
      proxied: true,
    });
    const redirect = rulesOf(resources, 'redirectRuleset', 'http_request_dynamic_redirect');
    expect(redirect).toEqual([
      expect.objectContaining({
        expression: '(http.host eq "www.panote.io")',
        action: 'redirect',
        actionParameters: {
          fromValue: {
            statusCode: 301,
            preserveQueryString: true,
            targetUrl: { expression: 'concat("https://panote.io", http.request.uri.path)' },
          },
        },
      }),
    ]);
  });
});

describe('the two stacks', () => {
  it('share no bucket or queue name', () => {
    const dev = stackSettings('dev');
    const production = stackSettings('production');
    const names = (s: Settings) => [s.bucket, s.uploadsQueue, s.deadLetterQueue, s.zone];
    for (const name of names(production)) expect(names(dev)).not.toContain(name);
    expect(dev.accountId).toBe(production.accountId);
  });
});

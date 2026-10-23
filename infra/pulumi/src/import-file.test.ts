import { describe, expect, it, vi } from 'vitest';

import {
  buildImportPlan,
  cloudflareGet,
  parseStackConfig,
  type CloudflareGet,
} from './import-file.js';
import { stackSettings } from './test-support.js';

const ACCOUNT = '12e2809e05de8a2bf20b815fd394ec9a';
const ZONE = '2196d8dead0322ad69307711fc72b5d3';

/** A read-only API double: path → response body, anything else 404s. */
function fakeApi(responses: Record<string, unknown>): CloudflareGet & { paths: string[] } {
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    return responses[path];
  };
  return Object.assign(get, { paths });
}

const DEV_API = {
  [`/zones?name=panote.dev&account.id=${ACCOUNT}`]: { result: [{ id: ZONE }] },
  [`/accounts/${ACCOUNT}/r2/buckets/pano-content-dev`]: { result: { name: 'pano-content-dev' } },
  [`/accounts/${ACCOUNT}/queues?per_page=100`]: {
    result: [
      { queue_id: 'q-uploads', queue_name: 'pano-uploads-dev' },
      { queue_id: 'q-dlq', queue_name: 'pano-uploads-dlq-dev' },
      { queue_id: 'q-prod', queue_name: 'pano-uploads' },
    ],
  },
  [`/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint`]: {
    result: { id: 'rs-waf' },
  },
  [`/zones/${ZONE}/rulesets/phases/http_request_cache_settings/entrypoint`]: {
    result: { id: 'rs-cache' },
  },
  [`/zones/${ZONE}/rulesets/phases/http_response_headers_transform/entrypoint`]: {
    result: { id: 'rs-headers' },
  },
  [`/zones/${ZONE}/dns_records?type=AAAA&name.exact=panote.dev`]: { result: [{ id: 'rec-apex' }] },
};

describe('buildImportPlan', () => {
  it('lists every existing dev resource with the id format its import needs', async () => {
    const api = fakeApi(DEV_API);
    const plan = await buildImportPlan(stackSettings('dev'), api);
    expect(plan.resources).toEqual([
      {
        type: 'cloudflare:index/r2Bucket:R2Bucket',
        name: 'content-bucket',
        id: `${ACCOUNT}/pano-content-dev/default`,
      },
      { type: 'cloudflare:index/queue:Queue', name: 'uploads-queue', id: `${ACCOUNT}/q-uploads` },
      { type: 'cloudflare:index/queue:Queue', name: 'uploads-dlq', id: `${ACCOUNT}/q-dlq` },
      {
        type: 'cloudflare:index/ruleset:Ruleset',
        name: 'waf-custom-rules',
        id: `zones/${ZONE}/rs-waf`,
      },
      {
        type: 'cloudflare:index/ruleset:Ruleset',
        name: 'cache-rules',
        id: `zones/${ZONE}/rs-cache`,
      },
      {
        type: 'cloudflare:index/ruleset:Ruleset',
        name: 'response-header-rules',
        id: `zones/${ZONE}/rs-headers`,
      },
      {
        type: 'cloudflare:index/zoneSetting:ZoneSetting',
        name: 'hsts',
        id: `${ZONE}/security_header`,
      },
      {
        type: 'cloudflare:index/urlNormalizationSettings:UrlNormalizationSettings',
        name: 'url-normalization',
        id: ZONE,
      },
      { type: 'cloudflare:index/dnsRecord:DnsRecord', name: 'apex-aaaa', id: `${ZONE}/rec-apex` },
    ]);
    // No rate-limit entrypoint yet: the first up creates it.
    expect(plan.missing).toEqual(['rate-limit-rules']);
    expect(plan.notImportable).toEqual([
      'content-bucket-cors',
      'content-bucket-r2-dev-domain',
      'cdn-domain',
      'upload-notification',
    ]);
    // dev has no www redirect, so its ruleset and record are never looked up.
    expect(
      api.paths.some((path) => path.includes('dynamic_redirect') || path.includes('www.')),
    ).toBe(false);
  });

  it('on an empty production account, imports only what always exists', async () => {
    const zone = '0123456789abcdef0123456789abcdef';
    const plan = await buildImportPlan(
      stackSettings('production'),
      fakeApi({
        [`/zones?name=panote.io&account.id=${ACCOUNT}`]: { result: [{ id: zone }] },
        [`/accounts/${ACCOUNT}/queues?per_page=100`]: { result: [] },
        [`/zones/${zone}/dns_records?type=AAAA&name.exact=panote.io`]: { result: [] },
        [`/zones/${zone}/dns_records?type=AAAA&name.exact=www.panote.io`]: { result: [] },
      }),
    );
    expect(plan.resources.map((entry) => entry.name)).toEqual(['hsts', 'url-normalization']);
    expect(plan.missing).toEqual([
      'content-bucket',
      'uploads-queue',
      'uploads-dlq',
      'waf-custom-rules',
      'rate-limit-rules',
      'cache-rules',
      'response-header-rules',
      'redirect-rules',
      'apex-aaaa',
      'www-aaaa',
    ]);
  });

  it('stops when the zone is not in the account', async () => {
    await expect(
      buildImportPlan(
        stackSettings('dev'),
        fakeApi({ [`/zones?name=panote.dev&account.id=${ACCOUNT}`]: { result: [] } }),
      ),
    ).rejects.toThrow(/zone panote.dev not found/);
  });

  it('stops on an ambiguous DNS record', async () => {
    const api = fakeApi({
      ...DEV_API,
      [`/zones/${ZONE}/dns_records?type=AAAA&name.exact=panote.dev`]: {
        result: [{ id: 'a' }, { id: 'b' }],
      },
    });
    await expect(buildImportPlan(stackSettings('dev'), api)).rejects.toThrow(/2 matches/);
  });

  it('stops on a response without a result list', async () => {
    const api = fakeApi({ ...DEV_API, [`/accounts/${ACCOUNT}/queues?per_page=100`]: {} });
    await expect(buildImportPlan(stackSettings('dev'), api)).rejects.toThrow(/queues: no result/);
  });
});

describe('cloudflareGet', () => {
  const response = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('GETs the v4 API with the token and returns the body', async () => {
    const fetchImpl = vi.fn(async () => response(200, { result: [] }));
    const get = cloudflareGet('tok', fetchImpl as unknown as typeof fetch);
    await expect(get('/zones?name=x')).resolves.toEqual({ result: [] });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cloudflare.com/client/v4/zones?name=x', {
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('maps 404 to undefined', async () => {
    const get = cloudflareGet('tok', (async () => response(404, {})) as unknown as typeof fetch);
    await expect(get('/x')).resolves.toBeUndefined();
  });

  it('throws with the API errors on any other failure', async () => {
    const get = cloudflareGet('tok', (async () =>
      response(403, {
        errors: [{ code: 10000, message: 'Authentication error' }],
      })) as unknown as typeof fetch);
    await expect(get('/x')).rejects.toThrow('GET /x: HTTP 403 (10000 Authentication error)');
  });
});

describe('parseStackConfig', () => {
  it('reads the namespaced keys and ignores everything else', () => {
    const values = parseStackConfig(
      [
        '# comment',
        'encryptionsalt: v1:abc',
        'config:',
        '  panote-infra:zone: panote.dev',
        '  panote-infra:bucket: "pano-content-dev"',
        '  panote-infra:auth0LocalDevCallbacks: true',
        '  cloudflare:apiToken: nope',
        '  auth0:domain: panote-dev.au.auth0.com',
        '  auth0:clientSecret: nope',
        '  github:owner: joeldn',
        '  github:token:',
        '    secure: v1:abc',
        '  panote-infra:bannedEmailSha256:',
        '    secure: v1:abc',
      ].join('\n'),
    );
    expect(Object.fromEntries(values)).toEqual({
      zone: 'panote.dev',
      bucket: 'pano-content-dev',
      auth0LocalDevCallbacks: 'true',
      'auth0:domain': 'panote-dev.au.auth0.com',
      'github:owner': 'joeldn',
    });
  });
});

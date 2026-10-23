import { readFileSync } from 'node:fs';

import type * as cloudflare from '@pulumi/cloudflare';

type RulesetRule = cloudflare.types.input.RulesetRule;
type CorsRule = cloudflare.types.input.R2BucketCorsRule;

/**
 * `infra/`: the JSON files there are the single source for bucket CORS and the
 * CDN cache rules. Resolved from this module, so it is the same from `src/`
 * (tests) and `dist/` (the built program).
 */
const INFRA_DIR = new URL('../../', import.meta.url);

function readJson(relative: string, infraDir: URL): unknown {
  return JSON.parse(readFileSync(new URL(relative, infraDir), 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(where: string, value: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`${where}: unsupported key(s) ${extra.join(', ')}`);
}

function stringArray(where: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${where}: expected an array of strings`);
  }
  return value;
}

/**
 * `infra/r2/<file>`, in Cloudflare's R2 CORS shape (`wrangler r2 bucket cors
 * set` reads the same file), as the provider's rules.
 */
export function loadCorsRules(file: string, infraDir = INFRA_DIR): CorsRule[] {
  const json = readJson(`r2/${file}`, infraDir);
  if (!isRecord(json) || !Array.isArray(json.rules)) throw new Error(`r2/${file}: no rules array`);
  return json.rules.map((rule, i): CorsRule => {
    const where = `r2/${file} rule ${i}`;
    if (!isRecord(rule) || !isRecord(rule.allowed)) throw new Error(`${where}: no allowed block`);
    onlyKeys(where, rule, ['allowed', 'maxAgeSeconds']);
    onlyKeys(where, rule.allowed, ['origins', 'methods', 'headers']);
    const out: CorsRule = {
      allowed: {
        origins: stringArray(`${where} origins`, rule.allowed.origins),
        methods: stringArray(`${where} methods`, rule.allowed.methods),
        ...(rule.allowed.headers === undefined
          ? {}
          : { headers: stringArray(`${where} headers`, rule.allowed.headers) }),
      },
    };
    if (rule.maxAgeSeconds !== undefined) {
      if (typeof rule.maxAgeSeconds !== 'number') throw new Error(`${where}: maxAgeSeconds`);
      out.maxAgeSeconds = rule.maxAgeSeconds;
    }
    return out;
  });
}

/**
 * `infra/cloudflare/<file>`: the zone's Cache Rules, in the Rulesets API's own
 * snake_case shape, as the provider's camelCase rules. Only the keys these
 * rules use are converted; anything else fails loudly rather than being
 * dropped. Every rule must target `cdn.<zone>`, which catches a dev file wired
 * into the production stack.
 */
export function loadCacheRules(file: string, zone: string, infraDir = INFRA_DIR): RulesetRule[] {
  const json = readJson(`cloudflare/${file}`, infraDir);
  if (!isRecord(json) || !Array.isArray(json.rules)) {
    throw new Error(`cloudflare/${file}: no rules array`);
  }
  onlyKeys(`cloudflare/${file}`, json, ['rules']);
  const host = `http.host eq "cdn.${zone}"`;
  return json.rules.map((rule, i): RulesetRule => {
    const where = `cloudflare/${file} rule ${i}`;
    if (!isRecord(rule)) throw new Error(`${where}: not an object`);
    onlyKeys(where, rule, [
      'ref',
      'description',
      'expression',
      'action',
      'action_parameters',
      'enabled',
    ]);
    const { ref, description, expression, action, enabled } = rule;
    if (typeof ref !== 'string' || !ref) throw new Error(`${where}: needs a ref`);
    if (typeof expression !== 'string' || !expression.includes(host)) {
      throw new Error(`${where}: expression must match ${host}`);
    }
    if (action !== 'set_cache_settings') throw new Error(`${where}: action ${String(action)}`);
    const params = rule.action_parameters;
    if (!isRecord(params)) throw new Error(`${where}: no action_parameters`);
    onlyKeys(where, params, ['cache', 'edge_ttl']);
    const out: RulesetRule = {
      ref,
      expression,
      action,
      enabled: enabled !== false,
      actionParameters: {
        ...(typeof params.cache === 'boolean' ? { cache: params.cache } : {}),
        ...(params.edge_ttl === undefined ? {} : { edgeTtl: edgeTtl(where, params.edge_ttl) }),
      },
    };
    if (typeof description === 'string') out.description = description;
    return out;
  });
}

function edgeTtl(where: string, value: unknown) {
  if (!isRecord(value) || typeof value.mode !== 'string') throw new Error(`${where}: edge_ttl`);
  onlyKeys(`${where} edge_ttl`, value, ['mode', 'default', 'status_code_ttl']);
  const ttls = value.status_code_ttl ?? [];
  if (!Array.isArray(ttls)) throw new Error(`${where}: status_code_ttl`);
  return {
    mode: value.mode,
    ...(typeof value.default === 'number' ? { default: value.default } : {}),
    statusCodeTtls: ttls.map((ttl) => {
      if (!isRecord(ttl) || typeof ttl.status_code !== 'number' || typeof ttl.value !== 'number') {
        throw new Error(`${where}: status_code_ttl entries need status_code and value`);
      }
      onlyKeys(`${where} status_code_ttl`, ttl, ['status_code', 'value']);
      return { statusCode: ttl.status_code, value: ttl.value };
    }),
  };
}

/** The CDN's public prefixes. Everything else in the bucket is private. */
export const PUBLIC_CDN_PREFIXES = ['/tiles/', '/pub/', '/slugs/'] as const;

/**
 * WAF custom rules (`http_request_firewall_custom`). An R2 custom domain
 * serves the whole bucket, so the first rule blocks every path outside the
 * public prefixes (fail-closed: a new private prefix is blocked by default).
 * The second blocks any query string on the CDN: nothing panote serves there
 * takes one, and each distinct query is a separate cache key, so it would
 * only let someone walk around the edge cache to R2.
 */
export function wafRules(zone: string): RulesetRule[] {
  const host = `cdn.${zone}`;
  const allowed = PUBLIC_CDN_PREFIXES.map(
    (prefix) => `starts_with(http.request.uri.path, "${prefix}")`,
  ).join(' or ');
  return [
    {
      ref: 'cdn-private-prefixes',
      description: `Block everything on ${host} outside the public prefixes`,
      expression: `(http.host eq "${host}" and not (${allowed}))`,
      action: 'block',
      enabled: true,
    },
    {
      ref: 'cdn-no-query-string',
      description: `Block query strings on ${host}`,
      expression: `(http.host eq "${host}" and http.request.uri.query ne "")`,
      action: 'block',
      enabled: true,
    },
  ];
}

/**
 * Rate limiting (`http_ratelimit`) on the APIs and the share-link script, at
 * the Free plan's limits: one rule, `ip.src` + `cf.colo.id`, a 10 s period
 * and a 10 s block. A backstop in front of the Workers' own limiters (Rate
 * limits in docs/deploy.md), which still run.
 */
export function rateLimitRules(): RulesetRule[] {
  return [
    {
      ref: 'api-and-share-links',
      description: 'Per-IP limit on /api/ and /s/',
      expression:
        '(starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/s/"))',
      action: 'block',
      enabled: true,
      ratelimit: {
        characteristics: ['ip.src', 'cf.colo.id'],
        period: 10,
        requestsPerPeriod: 100,
        mitigationTimeout: 10,
      },
    },
  ];
}

/**
 * Response header transforms (`http_response_headers_transform`). The CDN
 * serves user uploads, so nothing on it may be sniffed into or run as a
 * document. On dev, every response of the zone is also marked noindex (the
 * "Zone-wide guard" in docs/deploy.md).
 */
export function responseHeaderRules(zone: string, noindexAllResponses: boolean): RulesetRule[] {
  const rules: RulesetRule[] = [
    {
      ref: 'cdn-content-headers',
      description: `nosniff and a no-content CSP on cdn.${zone}`,
      expression: `(http.host eq "cdn.${zone}")`,
      action: 'rewrite',
      enabled: true,
      actionParameters: {
        headers: {
          'X-Content-Type-Options': { operation: 'set', value: 'nosniff' },
          'Content-Security-Policy': { operation: 'set', value: "default-src 'none'; sandbox" },
        },
      },
    },
  ];
  if (noindexAllResponses) {
    rules.push({
      ref: 'noindex-everything',
      description: `noindex everything on ${zone}`,
      expression: 'true',
      action: 'rewrite',
      enabled: true,
      actionParameters: {
        headers: { 'X-Robots-Tag': { operation: 'set', value: 'noindex, nofollow' } },
      },
    });
  }
  return rules;
}

/** `www.<zone>` → `https://<zone><path>`, 301, query string kept. */
export function wwwRedirectRules(zone: string): RulesetRule[] {
  return [
    {
      ref: 'www-to-apex',
      description: `www.${zone} to ${zone}`,
      expression: `(http.host eq "www.${zone}")`,
      action: 'redirect',
      enabled: true,
      actionParameters: {
        fromValue: {
          statusCode: 301,
          preserveQueryString: true,
          targetUrl: { expression: `concat("https://${zone}", http.request.uri.path)` },
        },
      },
    },
  ];
}

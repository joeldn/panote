/**
 * Logical (Pulumi) names and resource types, shared by the program and the
 * import-file script so an import always lands on the resource the program
 * declares. Renaming one of these makes Pulumi delete and recreate the
 * resource unless an `aliases` entry is added.
 */
export const RESOURCES = {
  bucket: { name: 'content-bucket', type: 'cloudflare:index/r2Bucket:R2Bucket' },
  bucketCors: { name: 'content-bucket-cors', type: 'cloudflare:index/r2BucketCors:R2BucketCors' },
  managedDomain: {
    name: 'content-bucket-r2-dev-domain',
    type: 'cloudflare:index/r2ManagedDomain:R2ManagedDomain',
  },
  cdnDomain: { name: 'cdn-domain', type: 'cloudflare:index/r2CustomDomain:R2CustomDomain' },
  uploadsQueue: { name: 'uploads-queue', type: 'cloudflare:index/queue:Queue' },
  deadLetterQueue: { name: 'uploads-dlq', type: 'cloudflare:index/queue:Queue' },
  uploadNotification: {
    name: 'upload-notification',
    type: 'cloudflare:index/r2BucketEventNotification:R2BucketEventNotification',
  },
  wafRuleset: { name: 'waf-custom-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  rateLimitRuleset: { name: 'rate-limit-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  cacheRuleset: { name: 'cache-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  responseHeaderRuleset: {
    name: 'response-header-rules',
    type: 'cloudflare:index/ruleset:Ruleset',
  },
  redirectRuleset: { name: 'redirect-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  hsts: { name: 'hsts', type: 'cloudflare:index/zoneSetting:ZoneSetting' },
  urlNormalization: {
    name: 'url-normalization',
    type: 'cloudflare:index/urlNormalizationSettings:UrlNormalizationSettings',
  },
  apexRecord: { name: 'apex-aaaa', type: 'cloudflare:index/dnsRecord:DnsRecord' },
  wwwRecord: { name: 'www-aaaa', type: 'cloudflare:index/dnsRecord:DnsRecord' },
} as const;

export type ResourceKey = keyof typeof RESOURCES;

/** Each zone entrypoint ruleset and the phase it owns. */
export const RULESET_PHASES = {
  wafRuleset: 'http_request_firewall_custom',
  rateLimitRuleset: 'http_ratelimit',
  cacheRuleset: 'http_request_cache_settings',
  responseHeaderRuleset: 'http_response_headers_transform',
  redirectRuleset: 'http_request_dynamic_redirect',
} as const satisfies Partial<Record<ResourceKey, string>>;

import * as cloudflare from '@pulumi/cloudflare';
import type * as pulumi from '@pulumi/pulumi';

import { createAuth0, type Auth0Outputs, type Auth0Secrets } from './auth0.js';
import { createGithub } from './github.js';
import { RESOURCES, RULESET_PHASES, type ResourceKey } from './names.js';
import {
  loadCacheRules,
  loadCorsRules,
  rateLimitRules,
  responseHeaderRules,
  wafRules,
  wwwRedirectRules,
} from './rules.js';
import type { Settings } from './settings.js';

/** Queues' maximum message retention: 14 days. The default is 4. */
export const QUEUE_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * HSTS on every host of the zone: one year, subdomains, not preloaded. The
 * same max-age the apps' own `Strict-Transport-Security` header sends
 * (`@internal/web-kit`'s headers.ts), so the two never disagree. In the API's
 * snake_case: `ZoneSetting.value` is untyped JSON, so the keys are sent as
 * written whether or not the bridge would have renamed camelCase ones.
 */
export const HSTS = {
  enabled: true,
  max_age: 31536000,
  include_subdomains: true,
  preload: false,
  nosniff: false,
} as const;

/**
 * What wrangler's `--event-type object-create` stands for: the notification
 * docs/deploy.md describes (R2 → queue notification).
 */
export const OBJECT_CREATE_ACTIONS = ['PutObject', 'CopyObject', 'CompleteMultipartUpload'];

/**
 * Placeholder target for proxied hostnames whose traffic is served entirely
 * by Workers routes (docs/deploy.md, DNS / zone setup).
 */
const WORKERS_ONLY_ADDRESS = '100::';

export interface Infra {
  /** Every resource declared, by its key in names.ts. */
  resources: Partial<Record<ResourceKey, pulumi.CustomResource>>;
  zoneId: pulumi.Output<string>;
  bucketName: pulumi.Output<string>;
  uploadsQueueId: pulumi.Output<string>;
  deadLetterQueueId: pulumi.Output<string>;
  cdnHost: string;
  /** Absent while the stack names no Auth0 tenant. */
  auth0?: Auth0Outputs;
}

/**
 * Declares one environment's Cloudflare resources and, once the stack names
 * its tenant, its Auth0 tenant (src/auth0.ts), and once it names the GitHub
 * owner, what it owns of the repository (src/github.ts). Workers, their routes and
 * bindings are not here: wrangler deploys those (`deploy.yml`).
 */
export function createInfra(settings: Settings, auth0Secrets: Auth0Secrets = {}): Infra {
  const { accountId, zone } = settings;
  const resources: Infra['resources'] = {};
  const track = <T extends pulumi.CustomResource>(key: ResourceKey, resource: T): T => {
    resources[key] = resource;
    return resource;
  };
  const cdnHost = `cdn.${zone}`;
  const zoneId = cloudflare.getZoneOutput({
    filter: { name: zone, account: { id: accountId } },
  }).id;

  // --- R2 --------------------------------------------------------------------
  const bucket = track(
    'bucket',
    new cloudflare.R2Bucket(
      RESOURCES.bucket.name,
      { accountId, name: settings.bucket, location: settings.bucketLocation },
      // Every pano lives here. A replacement would delete the bucket, so it is
      // protected, and the location hint (only read at creation) never forces
      // one.
      { protect: true, ignoreChanges: ['location', 'storageClass'] },
    ),
  );
  track(
    'bucketCors',
    new cloudflare.R2BucketCors(RESOURCES.bucketCors.name, {
      accountId,
      bucketName: bucket.name,
      rules: loadCorsRules(settings.corsFile),
    }),
  );
  // Only the CDN custom domain serves the bucket, behind the WAF rules.
  track(
    'managedDomain',
    new cloudflare.R2ManagedDomain(RESOURCES.managedDomain.name, {
      accountId,
      bucketName: bucket.name,
      enabled: false,
    }),
  );

  // --- Queues ----------------------------------------------------------------
  const queueSettings = { messageRetentionPeriod: QUEUE_RETENTION_SECONDS };
  const queue = (key: 'uploadsQueue' | 'deadLetterQueue') =>
    track(
      key,
      new cloudflare.Queue(
        RESOURCES[key].name,
        { accountId, queueName: settings[key], settings: queueSettings },
        { protect: true },
      ),
    );
  const uploadsQueue = queue('uploadsQueue');
  const deadLetterQueue = queue('deadLetterQueue');
  track(
    'uploadNotification',
    new cloudflare.R2BucketEventNotification(RESOURCES.uploadNotification.name, {
      accountId,
      bucketName: bucket.name,
      queueId: uploadsQueue.queueId,
      rules: [{ actions: OBJECT_CREATE_ACTIONS, prefix: 'panos/', suffix: '/original' }],
    }),
  );

  // --- Zone rulesets (one entrypoint per phase) --------------------------------
  const ruleset = (key: keyof typeof RULESET_PHASES, rules: cloudflare.types.input.RulesetRule[]) =>
    track(
      key,
      new cloudflare.Ruleset(
        RESOURCES[key].name,
        {
          zoneId,
          kind: 'zone',
          // What the dashboard names a zone's entrypoint rulesets.
          name: 'default',
          phase: RULESET_PHASES[key],
          rules,
        },
        // A name change forces a replacement, which for the WAF ruleset would
        // briefly leave the CDN open. An imported ruleset keeps whatever name
        // the dashboard gave it.
        { ignoreChanges: ['name'] },
      ),
    );
  const waf = ruleset('wafRuleset', wafRules(zone));
  ruleset('rateLimitRuleset', rateLimitRules());
  ruleset('cacheRuleset', loadCacheRules(settings.cacheRulesFile, zone));
  ruleset('responseHeaderRuleset', responseHeaderRules(zone, settings.noindexAllResponses));

  // --- Zone settings -----------------------------------------------------------
  track(
    'hsts',
    new cloudflare.ZoneSetting(RESOURCES.hsts.name, {
      zoneId,
      settingId: 'security_header',
      value: { strict_transport_security: HSTS },
    }),
  );
  // URL normalization, which makes `/tiles/../panos/` hit the WAF rule, is a dashboard setting:
  // its API refused every API token tried (infra/README.md, "Not managed here yet").

  // --- CDN domain, only once the WAF rules guard it ------------------------------
  track(
    'cdnDomain',
    new cloudflare.R2CustomDomain(
      RESOURCES.cdnDomain.name,
      { accountId, bucketName: bucket.name, domain: cdnHost, zoneId, enabled: true },
      { dependsOn: [waf] },
    ),
  );

  // --- DNS -----------------------------------------------------------------------
  // The CDN's record belongs to the custom domain above. Email records
  // (panote.io's Email Routing) are not managed here.
  const workersOnlyRecord = (key: 'apexRecord' | 'wwwRecord', name: string) =>
    track(
      key,
      new cloudflare.DnsRecord(RESOURCES[key].name, {
        zoneId,
        name,
        type: 'AAAA',
        content: WORKERS_ONLY_ADDRESS,
        proxied: true,
        ttl: 1,
      }),
    );
  workersOnlyRecord('apexRecord', zone);
  if (settings.wwwRedirect) {
    workersOnlyRecord('wwwRecord', `www.${zone}`);
    ruleset('redirectRuleset', wwwRedirectRules(zone));
  }

  const auth0 = settings.auth0 && createAuth0(zone, settings.auth0, auth0Secrets, track);
  if (settings.github) createGithub(settings, settings.github, track);

  return {
    resources,
    zoneId,
    bucketName: bucket.name,
    uploadsQueueId: uploadsQueue.queueId,
    deadLetterQueueId: deadLetterQueue.queueId,
    cdnHost,
    ...(auth0 ? { auth0 } : {}),
  };
}

import * as pulumi from '@pulumi/pulumi';

import { createInfra } from './infra.js';
import { AUTH0_DOMAIN_KEY, GITHUB_OWNER_KEY, readSettings } from './settings.js';

// The program entry (package.json "main", built to dist/). Everything it
// declares is in infra.ts, auth0.ts and github.ts; this only wires in the stack's config.
const config = new pulumi.Config();
// The Auth0 provider's own key, so the program and the provider name one tenant.
const auth0Domain = new pulumi.Config('auth0').get('domain');
// The GitHub provider's own key too, for the same reason.
const githubOwner = new pulumi.Config('github').get('owner');
const providerKeys: Record<string, string | undefined> = {
  [AUTH0_DOMAIN_KEY]: auth0Domain,
  [GITHUB_OWNER_KEY]: githubOwner,
};
const settings = readSettings(pulumi.getStack(), {
  require: (key) => config.require(key),
  get: (key) => (key in providerKeys ? providerKeys[key] : config.get(key)),
  getBoolean: (key) => config.getBoolean(key),
});
const infra = createInfra(settings, {
  googleClientSecret: settings.auth0?.googleClientId
    ? config.requireSecret('googleClientSecret')
    : undefined,
  bannedEmailSha256: config.getSecret('bannedEmailSha256'),
});

export const zoneId = infra.zoneId;
export const bucketName = infra.bucketName;
export const uploadsQueueId = infra.uploadsQueueId;
export const deadLetterQueueId = infra.deadLetterQueueId;
export const cdnHost = infra.cdnHost;
// What the apps' and APIs' config must say (docs/deploy.md, Production runbook step 10).
export const auth0SpaClientId = infra.auth0?.spaClientId;
export const auth0Issuer = infra.auth0?.issuer;
export const auth0Audience = infra.auth0?.audience;

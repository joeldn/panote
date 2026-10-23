import * as pulumi from '@pulumi/pulumi';

import { createInfra } from './infra.js';
import { AUTH0_DOMAIN_KEY, readSettings } from './settings.js';

// The program entry (package.json "main", built to dist/). Everything it
// declares is in infra.ts and auth0.ts; this only wires in the stack's config.
const config = new pulumi.Config();
// The Auth0 provider's own key, so the program and the provider name one tenant.
const auth0Domain = new pulumi.Config('auth0').get('domain');
const settings = readSettings(pulumi.getStack(), {
  require: (key) => config.require(key),
  get: (key) => (key === AUTH0_DOMAIN_KEY ? auth0Domain : config.get(key)),
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

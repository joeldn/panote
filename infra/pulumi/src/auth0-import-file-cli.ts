import { readFileSync, writeFileSync } from 'node:fs';

import { auth0Get, buildAuth0ImportPlan, spaClientIdFromEnv } from './auth0-import-file.js';
import { settingsFromStackFile } from './import-file.js';

/**
 * Writes `import.auth0.<stack>.json` for `pulumi import --file`
 * (infra/README.md, Auth0).
 *
 *   AUTH0_CLIENT_ID=... AUTH0_CLIENT_SECRET=... pnpm --filter @internal/infra run import-file-auth0 dev
 *
 * The tenant is the stack's `auth0:domain`. Read-only against the Management
 * API. Prints what will be imported and what doesn't exist yet to stderr.
 */
const log = (line: string) => process.stderr.write(`${line}\n`);
const stack = process.argv[2] ?? '';
const clientId = process.env.AUTH0_CLIENT_ID;
const clientSecret = process.env.AUTH0_CLIENT_SECRET;
if (stack !== 'dev' && stack !== 'production') {
  log('usage: import-file-auth0 <dev|production>');
  process.exit(1);
}
if (!clientId || !clientSecret) {
  log('import-file-auth0: set AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET');
  process.exit(1);
}

const packageDir = new URL('../', import.meta.url);
const repo = new URL('../../', packageDir);
const settings = settingsFromStackFile(
  stack,
  readFileSync(new URL(`Pulumi.${stack}.yaml`, packageDir), 'utf8'),
);
if (!settings.auth0) {
  log(`import-file-auth0: Pulumi.${stack}.yaml names no tenant (auth0:domain)`);
  process.exit(1);
}
const env = (app: string) => readFileSync(new URL(`apps/${app}/.env.${stack}`, repo), 'utf8');
const spaClientId = spaClientIdFromEnv(env('admin'), env('website'));

const plan = await buildAuth0ImportPlan(
  settings.zone,
  settings.auth0,
  spaClientId,
  await auth0Get(settings.auth0.domain, clientId, clientSecret),
);
const out = new URL(`import.auth0.${stack}.json`, packageDir);
writeFileSync(out, `${JSON.stringify({ resources: plan.resources }, null, 2)}\n`);

log(`Wrote ${out.pathname}: ${plan.resources.length} resources to import`);
for (const entry of plan.resources) log(`  import  ${entry.name}  ${entry.id}`);
for (const name of plan.missing) log(`  create  ${name} (doesn't exist yet)`);

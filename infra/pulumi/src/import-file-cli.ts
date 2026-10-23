import { readFileSync, writeFileSync } from 'node:fs';

import { buildImportPlan, cloudflareGet, parseStackConfig } from './import-file.js';
import { readSettings } from './settings.js';

/**
 * Writes `import.<stack>.json` for `pulumi import --file` (infra/README.md).
 *
 *   CLOUDFLARE_API_TOKEN=... pnpm --filter @internal/infra run import-file dev
 *
 * Read-only against the API. Prints what will be imported, what doesn't exist
 * yet and what can't be imported to stderr.
 */
const log = (line: string) => process.stderr.write(`${line}\n`);
const stack = process.argv[2] ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (stack !== 'dev' && stack !== 'production') {
  log('usage: import-file <dev|production>');
  process.exit(1);
}
if (!token) {
  log('import-file: set CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const packageDir = new URL('../', import.meta.url);
const values = parseStackConfig(readFileSync(new URL(`Pulumi.${stack}.yaml`, packageDir), 'utf8'));
const settings = readSettings(stack, {
  get: (key) => values.get(key),
  require: (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Pulumi.${stack}.yaml: no panote-infra:${key}`);
    return value;
  },
  getBoolean: (key) => (values.has(key) ? values.get(key) === 'true' : undefined),
});

const plan = await buildImportPlan(settings, cloudflareGet(token));
const out = new URL(`import.${stack}.json`, packageDir);
writeFileSync(out, `${JSON.stringify({ resources: plan.resources }, null, 2)}\n`);

log(`Wrote ${out.pathname}: ${plan.resources.length} resources to import`);
for (const entry of plan.resources) log(`  import  ${entry.name}  ${entry.id}`);
for (const name of plan.missing) log(`  create  ${name} (doesn't exist yet)`);
for (const name of plan.notImportable) log(`  adopt   ${name} (no import; up writes it)`);

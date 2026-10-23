import { readFileSync, writeFileSync } from 'node:fs';

import { buildGithubImportPlan, githubGet } from './github-import-file.js';
import { settingsFromStackFile } from './import-file.js';

/**
 * Writes `import.github.<stack>.json` for `pulumi import --file`
 * (infra/README.md, GitHub).
 *
 *   GITHUB_TOKEN=... pnpm --filter @internal/infra run import-file-github dev
 *
 * The repository is the stack's `github:owner` and `githubRepository`.
 * Read-only against the REST API. Prints what will be imported and what
 * doesn't exist yet to stderr.
 */
const log = (line: string) => process.stderr.write(`${line}\n`);
const stack = process.argv[2] ?? '';
const token = process.env.GITHUB_TOKEN;
if (stack !== 'dev' && stack !== 'production') {
  log('usage: import-file-github <dev|production>');
  process.exit(1);
}
if (!token) {
  log('import-file-github: set GITHUB_TOKEN');
  process.exit(1);
}

const packageDir = new URL('../', import.meta.url);
const settings = settingsFromStackFile(
  stack,
  readFileSync(new URL(`Pulumi.${stack}.yaml`, packageDir), 'utf8'),
);
if (!settings.github) {
  log(`import-file-github: Pulumi.${stack}.yaml names no GitHub owner (github:owner)`);
  process.exit(1);
}

const plan = await buildGithubImportPlan(settings, githubGet(token));
const out = new URL(`import.github.${stack}.json`, packageDir);
writeFileSync(out, `${JSON.stringify({ resources: plan.resources }, null, 2)}\n`);

log(`Wrote ${out.pathname}: ${plan.resources.length} resources to import`);
for (const entry of plan.resources) log(`  import  ${entry.name}  ${entry.id}`);
for (const name of plan.missing) log(`  create  ${name} (doesn't exist yet)`);

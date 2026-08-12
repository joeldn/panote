#!/usr/bin/env node
/**
 * Builds the Markdown body for the coverage PR comment and writes it to stdout.
 *
 * Reads each workspace's `coverage/lcov.info` (the reporter configured in
 * @internal/vitest-config). lcov is used rather than a JSON summary because
 * `json-summary` is not one of this repo's configured reporters and adding it
 * would mean editing a package's Vitest config, which is out of scope for a
 * CI change.
 *
 * There is deliberately no single repo-wide number. `@vitest/coverage-v8`
 * needs `node:inspector`, which workerd does not expose, so every workspace
 * tested through @cloudflare/vitest-pool-workers runs without coverage at all.
 * A workspace that has a Vitest config but emitted no lcov is reported as
 * "not measured" rather than as 0%, which is what averaging them would imply.
 *
 * Missing lcov is only harmless for the workerd/pool workspaces above. A
 * workspace that is NOT on that pool and still emitted no lcov is a real gap -
 * a broken config, a removed reporter, a crash before the report was written -
 * and is reported separately, as a problem, not folded into the expected group.
 * See `runsUnderWorkersPool` for how the two are told apart. When that happens
 * this script exits non-zero (see the bottom of the file) so the gap fails the
 * job even on a fork PR, where the comment step below is skipped.
 *
 * No dependencies: this runs on the CI runner straight after checkout.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_DIRS = ['packages', 'services'];

/** Marker used to find and update this comment instead of posting a new one. */
const MARKER = '<!-- panote:coverage -->';

/**
 * Sum the lcov summary counters across every file in a report.
 *
 * lcov records per source file: LF/LH (lines found/hit), FNF/FNH (functions),
 * BRF/BRH (branches). There is no statement counter in lcov - v8 reports
 * statements as lines - so the comment reports lines, functions and branches
 * and does not invent a statements column.
 */
function parseLcov(text) {
  const totals = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };
  const keys = {
    LF: ['lines', 'found'],
    LH: ['lines', 'hit'],
    FNF: ['functions', 'found'],
    FNH: ['functions', 'hit'],
    BRF: ['branches', 'found'],
    BRH: ['branches', 'hit'],
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const target = keys[line.slice(0, separator)];
    if (!target) continue;
    const value = Number(line.slice(separator + 1));
    if (!Number.isFinite(value)) continue;
    totals[target[0]][target[1]] += value;
  }

  return totals;
}

function formatMetric({ found, hit }) {
  if (found === 0) return 'n/a';
  return `${((hit / found) * 100).toFixed(1)}% (${hit}/${found})`;
}

/**
 * Package specifiers that, if referenced anywhere in a workspace's
 * `vitest.config.ts`, mean that workspace's tests execute inside `workerd` via
 * the Cloudflare Workers pool rather than under Node - which is what actually
 * makes `@vitest/coverage-v8` inoperable there (it needs `node:inspector`,
 * which `workerd` does not expose).
 *
 * Two specifiers, not one, because there are two ways a config ends up wired
 * to the pool:
 *
 *  - `@cloudflare/vitest-pool-workers` - referenced directly by a config that
 *    wires the pool itself (the `cloudflareTest` plugin, or the
 *    `defineWorkersConfig` helper from that package's `/config` entry point).
 *  - `@internal/vitest-config/workers` - this repo's shared factory entry
 *    point. Every current `services/*` package (`admin-api`, `public-api`,
 *    `tiler-consumer`, `upload-api`) imports `defineWorkerTestConfig` from
 *    here rather than wiring the pool itself, so `@cloudflare/vitest-pool-workers`
 *    never appears literally in their own `vitest.config.ts` - only inside the
 *    factory's own source (`packages/vitest-config/src/workers.ts`, which
 *    imports `cloudflareTest` from `@cloudflare/vitest-pool-workers`). Matching
 *    the factory's entry point too is what catches that indirection without
 *    having to open and resolve a second file - the factory's *name* is the
 *    signal, not its contents, and every consumer has to reference it by that
 *    exact specifier for Vitest to load it.
 *
 * One level of import indirection was deliberately not chased further than
 * this (e.g. resolving an arbitrary local import target and re-reading it):
 * every real config seen in this repo names one of these two specifiers
 * directly, so generic module resolution (workspace protocol, package.json
 * `exports`, extensionless TS resolution) would add real complexity for a
 * case with no current example. If a future config buries the pool behind a
 * second layer of indirection, that is a reason to extend this list, not to
 * build a resolver speculatively.
 *
 * The match is on the import's module specifier text, not the imported
 * binding name, so `import { defineWorkerTestConfig as x } from '...'` is
 * still caught regardless of what the consumer calls it locally.
 *
 * Deliberately NOT "lives under services/*" or any other location/name-based
 * heuristic. `packages/worker-kit` is why: it sits alongside the Worker
 * services and exists specifically to hold the logic that CAN be
 * unit-tested with coverage, so its `vitest.config.ts` imports
 * `@internal/vitest-config/node` (neither marker below) and it genuinely
 * produces lcov. A heuristic keyed on "looks like a Worker package" would put
 * it in the wrong bucket and hide a real coverage regression there.
 */
const WORKERS_POOL_MARKERS = ['@cloudflare/vitest-pool-workers', '@internal/vitest-config/workers'];

function runsUnderWorkersPool(root) {
  const configPath = join(root, 'vitest.config.ts');
  const source = readFileSync(configPath, 'utf8');
  return WORKERS_POOL_MARKERS.some((marker) => source.includes(marker));
}

/** Every workspace under packages/ and services/ that runs Vitest. */
function collectWorkspaces() {
  const workspaces = [];

  for (const dir of WORKSPACE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const root = join(dir, entry);
      const manifestPath = join(root, 'package.json');
      if (!existsSync(manifestPath)) continue;

      // A workspace with no Vitest config (the config-only packages) is not a
      // coverage gap and does not belong in the report at all.
      if (!existsSync(join(root, 'vitest.config.ts'))) continue;

      const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name ?? root;
      const lcovPath = join(root, 'coverage', 'lcov.info');
      workspaces.push({
        name,
        root,
        totals: existsSync(lcovPath) ? parseLcov(readFileSync(lcovPath, 'utf8')) : null,
        workersPool: runsUnderWorkersPool(root),
      });
    }
  }

  return workspaces;
}

function render(workspaces) {
  const measured = workspaces.filter((w) => w.totals !== null);
  // Split "no lcov" into the two cases that look identical from the filesystem
  // but mean opposite things: expected (runs under the Workers pool, coverage
  // is impossible there) and unexpected (a Node/browser workspace that should
  // have produced lcov and did not - a real gap, not a known limitation).
  const unmeasuredExpected = workspaces.filter((w) => w.totals === null && w.workersPool);
  const unmeasuredUnexpected = workspaces.filter((w) => w.totals === null && !w.workersPool);

  const lines = [MARKER, '', '## Coverage', ''];

  if (measured.length === 0) {
    lines.push(
      'No `coverage/lcov.info` was produced by any workspace. That is not a 0% result - ' +
        'it means `pnpm test:coverage` did not get far enough to write a report. ' +
        'Read the job log, not this table.',
    );
    return lines.join('\n');
  }

  lines.push('| Workspace | Lines | Functions | Branches |');
  lines.push('| --- | --- | --- | --- |');
  for (const workspace of measured) {
    lines.push(
      `| \`${workspace.name}\` | ${formatMetric(workspace.totals.lines)} | ` +
        `${formatMetric(workspace.totals.functions)} | ` +
        `${formatMetric(workspace.totals.branches)} |`,
    );
  }
  lines.push('');

  if (unmeasuredUnexpected.length > 0) {
    lines.push(
      `**⚠️ No coverage produced (${unmeasuredUnexpected.length}) - this is unexpected:** ` +
        unmeasuredUnexpected.map((w) => `\`${w.name}\``).join(', ') +
        '.',
    );
    lines.push('');
    lines.push(
      'These are not on the Workers pool (their `vitest.config.ts` does not reference ' +
        '`@cloudflare/vitest-pool-workers` or the shared `@internal/vitest-config/workers` ' +
        'factory), so they should have produced `coverage/lcov.info` ' +
        'the same as every measured workspace above. A missing report here is not a known ' +
        'limitation - it means `pnpm test:coverage` did not write one for this workspace: a ' +
        'broken Vitest config, a removed reporter, or a crash before the report was written. ' +
        'Read the job log for this workspace before merging. This is why this job fails.',
    );
    lines.push('');
  }

  if (unmeasuredExpected.length > 0) {
    lines.push(
      `**Not measured, expected (${unmeasuredExpected.length}):** ` +
        unmeasuredExpected.map((w) => `\`${w.name}\``).join(', ') +
        '.',
    );
    lines.push('');
    lines.push(
      'These run under `workerd` via `@cloudflare/vitest-pool-workers`. ' +
        '`@vitest/coverage-v8` needs `node:inspector`, which workerd does not expose, ' +
        'so their tests run with no coverage instrumentation. Their tests still run and ' +
        'still gate the merge - only the percentages are missing.',
    );
    lines.push('');
  }

  lines.push(
    '_Thresholds are enforced by `pnpm test:coverage` itself (per-package, in each ' +
      "workspace's `vitest.config.ts`), not by this comment. Lines/functions/branches " +
      'come from lcov, which has no statements counter - v8 reports statements as lines._',
  );

  return lines.join('\n');
}

const workspaces = collectWorkspaces();
process.stdout.write(`${render(workspaces)}\n`);

// An unexpected coverage gap fails the job (not just the comment): the
// "Build coverage comment" step in ci.yml has no `continue-on-error` and runs
// with `if: ${{ !cancelled() }}`, so a non-zero exit here fails that step and
// the job, on both same-repo and fork PRs. A comment alone is not enough - the
// "Post coverage comment" step is skipped on fork PRs (they get a read-only
// GITHUB_TOKEN), which is the one case this needs to be loud regardless of who
// sees the PR comment. Exit code is set (not `process.exit`) so the write above
// is never at risk of being cut off before it reaches the redirected file.
if (workspaces.some((w) => w.totals === null && !w.workersPool)) {
  process.exitCode = 1;
}

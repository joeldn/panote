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
      });
    }
  }

  return workspaces;
}

function render(workspaces) {
  const measured = workspaces.filter((w) => w.totals !== null);
  const unmeasured = workspaces.filter((w) => w.totals === null);

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

  if (unmeasured.length > 0) {
    lines.push(
      `**Not measured (${unmeasured.length}):** ` +
        unmeasured.map((w) => `\`${w.name}\``).join(', ') +
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

process.stdout.write(`${render(collectWorkspaces())}\n`);

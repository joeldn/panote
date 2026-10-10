import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VIEWER_DEFAULTS } from './defaults.js';

// The README's options table is the documentation of every default. It is
// written by hand, so this keeps it honest: every default appears with its
// exact value, and every option in the table is a real one.

/** Options with no default; the table says "none" for them. */
const NO_DEFAULT = ['resolveSource', 'initialView', 'network.fetch', 'network.decode'];

/** VIEWER_DEFAULTS as dotted paths to leaf values. Arrays and empty objects are leaves. */
function flatten(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

function readmeRows(): Map<string, string> {
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
  const start = readme.indexOf('<!-- options-table');
  expect(start).toBeGreaterThan(-1);
  const rows = new Map<string, string>();
  for (const line of readme.slice(start).split('\n').slice(1)) {
    if (!line.startsWith('|')) {
      if (rows.size > 0) break;
      continue;
    }
    const m = /^\| `([\w.]+)` \| ([^|]*) \|/.exec(line);
    if (m) rows.set(m[1]!, m[2]!.trim());
  }
  return rows;
}

describe('README options table', () => {
  const rows = readmeRows();
  const defaults = flatten(VIEWER_DEFAULTS);

  it.each(defaults)('documents %s with its default', (path, value) => {
    expect(rows.get(path)).toBe(`\`${JSON.stringify(value)}\``);
  });

  it('documents the options without a default as having none', () => {
    for (const path of NO_DEFAULT) expect(rows.get(path)).toBe('none');
  });

  it('lists nothing else', () => {
    expect([...rows.keys()].sort()).toEqual(
      [...defaults.map(([path]) => path), ...NO_DEFAULT].sort(),
    );
  });
});

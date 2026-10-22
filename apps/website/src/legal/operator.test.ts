// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as operator from './operator.js';

// The legal pages ship with placeholders until the operator's details are decided. They must
// stay in the YOUR_ form the production deploy guard looks for, and the guard must still scan
// this directory, or a placeholder could reach panote.io unnoticed.
describe('operator placeholders', () => {
  const deploy = readFileSync(
    new URL('../../../../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );

  it('the production deploy guard scans src/legal for YOUR_', () => {
    expect(deploy).toContain('apps/website/src/legal');
  });

  it.each(Object.entries(operator))('%s is a real value or a YOUR_ placeholder', (_, value) => {
    expect(typeof value).toBe('string');
    // A half-filled value ("TBD", "[name]") would slip past the guard.
    expect(value).not.toMatch(/\bTBD\b|\[|\]|TODO/i);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tour.css'), 'utf8');

describe('tour styles', () => {
  it('never blurs the backdrop over the pano', () => {
    expect(css).not.toMatch(/backdrop-filter/);
  });
});

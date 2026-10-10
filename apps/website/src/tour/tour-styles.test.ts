import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'tour.css'), 'utf8');
const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

describe('tour styles', () => {
  it('never blurs the backdrop over the pano', () => {
    expect(css).not.toMatch(/backdrop-filter/);
  });

  it('draws edge to edge, under the notch and the home indicator', () => {
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });

  it('keeps the embed chrome clear of the safe areas', () => {
    expect(css).toContain('top: calc(16px + env(safe-area-inset-top, 0px));');
    expect(css).toContain('left: calc(14px + env(safe-area-inset-left, 0px));');
  });
});

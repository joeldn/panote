import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');
const read = (f: string) => readFileSync(join(stylesDir, f), 'utf8');

describe('viewer chrome styles', () => {
  it('never blurs the backdrop: the pano under the chrome repaints every frame', () => {
    for (const f of ['tokens.css', 'components.css', 'viewer.css']) {
      expect(read(f), f).not.toMatch(/backdrop-filter/);
    }
    expect(read('tokens.css')).toContain('--cbg-solid: rgba(255, 255, 255, 0.94);');
  });
});

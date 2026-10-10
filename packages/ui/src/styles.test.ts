import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');
const read = (f: string) => readFileSync(join(stylesDir, f), 'utf8');
const imports = (css: string) =>
  [...css.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1] as string);
const require = createRequire(join(stylesDir, 'index.css'));

describe('styles', () => {
  it('defines every design token on :root (fixed-position subtrees need them)', () => {
    const css = read('tokens.css');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const expected: Record<string, string> = {
      '--accent': '#b5483a',
      '--ink': '#1a1815',
      '--paper': '#faf8f4',
      '--depth': '#2f8fb3',
      '--dark-panel': '#14130f',
      '--code-text': '#9fd0e0',
      '--success': '#5fae6e',
      '--cbg-solid': 'rgba(255, 255, 255, 0.94)',
      '--mbg': 'rgba(250, 248, 244, 0.62)',
      '--shadow-modal': '0 40px 100px rgba(0, 0, 0, 0.4)',
      '--shadow-chip': '0 10px 34px rgba(0, 0, 0, 0.3)',
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(root).toContain(`${name}: ${value};`);
    }
    expect(root).toMatch(/--fdisp: 'Schibsted Grotesk'/);
    expect(root).toMatch(/--fmono: 'Spline Sans Mono'/);
    for (const kf of ['pn-fadeup', 'pn-spin', 'pn-indet'])
      expect(css).toContain(`@keyframes ${kf}`);
  });

  it('only uses tokens that tokens.css defines', () => {
    const defined = new Set([...read('tokens.css').matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
    const used = ['components.css', 'viewer.css', 'share.css'].flatMap((f) =>
      [...read(f).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    const local = new Set(['--pn-modal-width', '--pn-modal-radius', '--pn-hs-scale']);
    expect(used.filter((u) => !defined.has(u) && !local.has(u as string))).toEqual([]);
  });

  it('self-hosts fonts and icons: every @import resolves to an installed file', () => {
    const packageImports = [...imports(read('fonts.css')), ...imports(read('icons.css'))];
    expect(packageImports.length).toBeGreaterThanOrEqual(8);
    for (const spec of packageImports) {
      expect(spec.startsWith('http')).toBe(false);
      expect(existsSync(require.resolve(spec))).toBe(true);
    }
    for (const local of imports(read('index.css'))) {
      expect(existsSync(join(stylesDir, local))).toBe(true);
    }
  });
});

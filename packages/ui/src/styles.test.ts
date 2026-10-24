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
    const local = new Set([
      '--pn-modal-width',
      '--pn-modal-radius',
      '--pn-vv-top',
      '--pn-keyboard',
      '--pn-hs-scale',
      '--pn-plan-ratio',
    ]);
    expect(used.filter((u) => !defined.has(u) && !local.has(u as string))).toEqual([]);
  });

  it('has one focus ring for everything, which components may adjust but not out-rank', () => {
    const css = read('components.css');
    const ring = /:where\(:focus-visible\) \{\s*outline: 2px solid var\(--accent\);/;
    expect(css).toMatch(ring);
    // The primitives no longer each repeat the ring.
    for (const f of ['components.css', 'share.css']) {
      expect(read(f)).not.toMatch(
        /\.pn-(btn|seg__opt|chip|modal__close|signin__option):focus-visible/,
      );
    }
  });

  it('turns a modal into a bottom sheet on a phone, clear of the safe areas', () => {
    const css = read('components.css');
    const at = css.indexOf('@media (max-width: 600px) {');
    expect(at).toBeGreaterThan(css.indexOf('\n.pn-modal {'));
    const block = css.slice(at, css.indexOf('/* --- ConfirmModal', at));
    expect(block).toMatch(/\.pn-scrim \{[^}]*align-items: flex-end;/);
    expect(block).toMatch(/\.pn-modal \{[^}]*env\(safe-area-inset-bottom, 0px\)/);
    expect(block).toMatch(/\.pn-modal \{[^}]*border-radius:[^;]*0 0;/);
    // Above an on-screen keyboard: Modal.tsx sets these from the visual viewport.
    expect(block).toMatch(
      /\.pn-scrim \{[^}]*var\(--pn-vv-top, 0px\)[^}]*var\(--pn-keyboard, 0px\)/,
    );
  });

  it('gives touch screens finger-sized targets', () => {
    const css = read('components.css');
    const block = css.slice(css.indexOf('@media (pointer: coarse) {'));
    expect(block).toMatch(
      /\.pn-btn:not\(\.pn-btn--sm, \.pn-btn--link\),\s*\.pn-menu__item \{\s*min-height: 44px;/,
    );
    expect(css).toMatch(/\n\.pn-icon-btn \{[^}]*width: 32px;[^}]*height: 32px;/);
    // The small one grows to 32px so the -6px reach makes 44px, as the regular one does.
    expect(block).toMatch(/\.pn-icon-btn::before \{[^}]*inset: -6px;/);
    expect(block).toMatch(/\.pn-icon-btn--sm \{\s*width: 32px;\s*height: 32px;/);
    expect(css).toMatch(/\n\.pn-menu__item \{[^}]*min-height: 32px;/);
  });

  it('self-hosts fonts and icons: every url() is a woff2 file that exists', () => {
    const urls = [...read('fonts.css').matchAll(/url\('([^']+)'\)/g)].map((m) => m[1] as string);
    const icons = [...read('icons.css').matchAll(/url\('([^']+)'\)/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThanOrEqual(12);
    expect(icons.length).toBe(2);
    for (const spec of [...urls, ...icons]) {
      expect(spec.startsWith('http')).toBe(false);
      expect(spec.endsWith('.woff2')).toBe(true);
      const file = spec.startsWith('./') ? join(stylesDir, spec) : require.resolve(spec);
      expect(existsSync(file)).toBe(true);
    }
    for (const local of imports(read('index.css'))) {
      expect(existsSync(join(stylesDir, local))).toBe(true);
    }
  });
});

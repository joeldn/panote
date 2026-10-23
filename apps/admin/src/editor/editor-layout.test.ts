// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BAR_MENU_MAX_WIDTH } from './MoreMenu.js';

// No browser runs these styles in CI, so the layout rules the editor depends on at narrow
// widths (C9) are checked as text: which media query holds them, and that they come after
// the rules they override.
const css = readFileSync(new URL('./editor.css', import.meta.url), 'utf8');

/** The body of the first `@media (max-width: <px>px)` block. */
function mediaBlock(px: number): { at: number; body: string } {
  const head = `@media (max-width: ${px}px) {`;
  const at = css.indexOf(head);
  if (at < 0) return { at, body: '' };
  let depth = 0;
  for (let i = at + head.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { at, body: css.slice(at + head.length, i) };
  }
  return { at, body: '' };
}

/** Where `selector {` first starts a rule outside any media block. */
const baseRule = (selector: string) => css.indexOf(`\n${selector} {`);

describe('editor layout CSS', () => {
  it('folds the bar’s tools into the More menu at the width MoreMenu names', () => {
    const { body } = mediaBlock(BAR_MENU_MAX_WIDTH);
    expect(body).toMatch(/\.ed-bar__tools\s*{\s*display:\s*none;/);
    expect(body).toMatch(/\.ed-more\s*{\s*display:\s*block;/);
    expect(css).toMatch(/\n\.ed-more\s*{\s*display:\s*none;/);
  });

  it('flows the bar, popovers and banners in one column at phone width, no fixed offset', () => {
    const { body } = mediaBlock(600);
    expect(body).toMatch(/\.ed-top\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);
    for (const part of ['.ed-bar', '.ed-popover', '.ed-banners']) {
      expect(body).toMatch(new RegExp(`\\.ed-top > \\${part}\\s*{[^}]*position:\\s*static;`));
    }
    // The banners used to sit at `top: 120px` under a bar of unknown height.
    expect(body).not.toMatch(/\.ed-banners\s*{[^}]*top:\s*\d/);
    expect(css).toMatch(/\n\.ed-top\s*{\s*display:\s*contents;/);
  });

  it('puts each narrow-width block after the rules it overrides', () => {
    const narrow = mediaBlock(BAR_MENU_MAX_WIDTH).at;
    const phone = mediaBlock(600).at;
    for (const sel of ['.ed-inline', '.ed-save-hint', '.ed-crumbs']) {
      expect(baseRule(sel)).toBeGreaterThan(-1);
      expect(baseRule(sel)).toBeLessThan(narrow);
    }
    for (const sel of ['.ed-popover', '.ed-banners', '.ed-compass', '.ed-placing__hint']) {
      expect(baseRule(sel)).toBeGreaterThan(-1);
      expect(baseRule(sel)).toBeLessThan(phone);
    }
    expect(narrow).toBeLessThan(phone);
  });

  it('keeps the banners and popovers clickable inside the phone column', () => {
    // .ed-top (and .ed-banners) let presses through to the pano; each banner and popover
    // takes them back, and its buttons inherit that.
    expect(mediaBlock(600).body).toMatch(/\.ed-top\s*{[^}]*pointer-events:\s*none;/);
    expect(css).toMatch(/\n\.ed-banner\s*{\s*pointer-events:\s*auto;/);
    expect(css).toMatch(/\n\.ed-popover\s*{\s*pointer-events:\s*auto;/);
  });

  it('has no rule spliced into another’s selector', () => {
    // A comment inside a selector list means a rule was pasted into the middle of another.
    for (const selector of css.matchAll(/(?:^|})\s*([^{}@]+){/g)) {
      const own = selector[1]!.replace(/^(\s*\/\*[\s\S]*?\*\/)*/, '').trim();
      expect(own).not.toMatch(/\/\*/);
    }
    expect(css).toMatch(/\n\.ed-map__image \.ed-label\s*{\s*margin-right:\s*auto;/);
    expect(css).toMatch(/\n\.ed-empty\s*{/);
    expect(css).not.toMatch(/\n\.ed-label\s*{\s*margin-right/);
  });
});

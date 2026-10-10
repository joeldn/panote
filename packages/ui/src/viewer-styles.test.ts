import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');
const read = (f: string) => readFileSync(join(stylesDir, f), 'utf8');
const viewer = read('viewer.css');

/** Body of the first rule whose selector list is exactly `selector`, optionally inside `@media`. */
function rule(css: string, selector: string, media?: string): string {
  let scope = css;
  if (media) {
    const at = css.indexOf(`@media ${media} {`);
    expect(at, `@media ${media}`).toBeGreaterThanOrEqual(0);
    scope = css.slice(at);
  }
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`).exec(scope);
  expect(m, selector).not.toBeNull();
  return m![1]!;
}

describe('viewer chrome styles', () => {
  it('never blurs the backdrop: the pano under the chrome repaints every frame', () => {
    for (const f of ['tokens.css', 'components.css', 'viewer.css']) {
      expect(read(f), f).not.toMatch(/backdrop-filter/);
    }
    expect(read('tokens.css')).toContain('--cbg-solid: rgba(255, 255, 255, 0.94);');
  });

  it('stacks the hotspot sheet above the controls pill and the map button', () => {
    expect(rule(viewer, '.pn-hspanel')).toMatch(/z-index: 2;/);
  });

  it('keeps edge chrome clear of the safe areas', () => {
    const inset = (side: string) => `env(safe-area-inset-${side}, 0px)`;
    expect(rule(viewer, '.pn-stage__overlay > .pn-tourbar')).toContain(inset('top'));
    expect(rule(viewer, '.pn-stage__overlay > .pn-tour__compass')).toContain(inset('top'));
    expect(rule(viewer, '.pn-controls--bottom')).toContain(inset('bottom'));
    expect(rule(viewer, '.pn-controls--bottom', '(max-width: 600px)')).toContain(inset('bottom'));
    expect(rule(viewer, '.pn-scenemap')).toContain(inset('bottom'));
    expect(rule(viewer, '.pn-scenemap', '(max-width: 600px)')).toContain(inset('bottom'));
    expect(rule(viewer, '.pn-hspanel')).toContain(inset('right'));
    expect(rule(viewer, '.pn-hspanel', '(max-width: 600px)')).toContain(inset('bottom'));
  });

  it('keeps touches on the chrome from zooming the page, but lets panels scroll', () => {
    expect(rule(viewer, '.pn-tour')).toMatch(/touch-action: none;/);
    for (const panel of ['.pn-hspanel', '.pn-scenemap__panel']) {
      expect(rule(viewer, panel), panel).toMatch(/touch-action: pan-y;/);
      expect(rule(viewer, panel), panel).toMatch(/overscroll-behavior: contain;/);
    }
    expect(rule(viewer, '.pn-scenemap__panel')).toMatch(/max-height: 60dvh;/);
  });

  it('paints the page dark behind a tour, not the light app background', () => {
    expect(rule(viewer, ':root:has(.pn-tour) body')).toMatch(/background: #0d0c0a;/);
  });
});

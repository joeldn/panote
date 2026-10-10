// @vitest-environment node
// Node, not jsdom: subset-font's wasm rejects jsdom's typed arrays.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import subsetFont from 'subset-font';
import { describe, expect, it } from 'vitest';

import { codepointsFor, faCodepoints, iconsCss } from './css.js';
import {
  BRAND_ICONS,
  FALLBACK_ICON,
  POINT_ICONS,
  pointIcon,
  SOLID_ICONS,
  UI_ICONS,
} from './names.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = join(pkg, '..', '..');
const styles = join(pkg, 'styles');
const require = createRequire(join(pkg, 'package.json'));
const faDir = dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
const fa = (path: string) => readFileSync(join(faDir, path));
const codepoints = faCodepoints(
  fa('css/fontawesome.min.css').toString() + fa('css/brands.min.css').toString(),
);

const SKIP = new Set([join(pkg, 'src', 'icons')]);

/** Source files that can render an icon class (tests excluded: they may use fake names). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    // src/icons is the list and the generator, not a consumer.
    if (statSync(path).isDirectory()) return SKIP.has(path) ? [] : sources(path);
    return /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

// Font Awesome classes that aren't icons.
const MODIFIERS = new Set(['solid', 'brands', 'spin']);

const used = new Map<string, string>();
/** Every `fa-${expr}` class built at runtime, as "file: expr". */
const dynamic: string[] = [];
for (const dir of [
  'apps/website/src',
  'apps/admin/src',
  'packages/ui/src',
  'packages/web-kit/src',
]) {
  for (const file of sources(join(repo, dir))) {
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(repo.length + 1);
    for (const m of text.matchAll(/(?<![\w-])fa-([a-z0-9-]+)/g)) {
      const name = m[1] as string;
      if (!MODIFIERS.has(name) && !used.has(name)) used.set(name, rel);
    }
    for (const m of text.matchAll(/(?<![\w-])fa-\$\{([^}]*)\}/g)) dynamic.push(`${rel}: ${m[1]}`);
    for (const m of text.matchAll(/['"`]fa-['"`]\s*\+\s*[^\s;]+/g)) dynamic.push(`${rel}: ${m[0]}`);
  }
}

// Dynamic names the grep above can't see. Each must go through pointIcon() (which
// maps anything off-list to the fallback) or be a known-good site below.
const DYNAMIC_ALLOWED = new Set([
  // The picker maps over searchIcons(), which only returns POINT_ICONS.
  'apps/admin/src/editor/PointEditor.tsx: name',
]);
// The generated stylesheet itself lives in styles/, outside the scanned dirs.
const css = readFileSync(join(styles, 'icons.css'), 'utf8');
const rule = (name: string) => new RegExp(`^\\.fa-${name} \\{\\n  --fa: '\\\\[0-9a-f]+';`, 'm');

describe('icon subset', () => {
  it('finds the icon classes the UI renders (sanity check for the scan)', () => {
    expect(used.size).toBeGreaterThan(50);
    expect(used.get('compress')).toMatch(/ViewerControls\.tsx$/);
    expect(used.get('x-twitter')).toMatch(/links\.ts$/);
  });

  it('ships every icon class the UI renders, plus every point icon', () => {
    const shipped = new Set([...SOLID_ICONS, ...BRAND_ICONS]);
    const missing = [...used].filter(([name]) => !shipped.has(name));
    expect(missing).toEqual([]);
    for (const name of [...used.keys(), ...POINT_ICONS]) expect(css).toMatch(rule(name));
  });

  it('builds dynamic icon names only through pointIcon() or a listed site', () => {
    const bad = dynamic.filter((d) => !/: pointIcon\(/.test(d) && !DYNAMIC_ALLOWED.has(d));
    expect(bad).toEqual([]);
    // The scan sees the known sites (so an empty `bad` isn't vacuous).
    for (const site of [
      'packages/ui/src/viewer/HotspotMarkers.tsx: pointIcon(h.icon)',
      'packages/ui/src/viewer/HotspotPanel.tsx: pointIcon(hotspot.icon)',
      'apps/admin/src/editor/Editor.tsx: pointIcon(h.icon)',
      ...DYNAMIC_ALLOWED,
    ]) {
      expect(dynamic).toContain(site);
    }
  });

  it('keeps styles/icons.css in step with the lists (rerun gen:icons after an edit)', () => {
    const { version } = JSON.parse(fa('package.json').toString()) as { version: string };
    const expected = iconsCss({
      solid: SOLID_ICONS,
      brands: BRAND_ICONS,
      codepoints,
      fallback: FALLBACK_ICON,
      version,
    });
    expect(css).toBe(expected);
  });

  it('keeps the subset fonts in step with the lists', async () => {
    for (const [font, out, names] of [
      ['fa-solid-900.woff2', 'fa-solid-subset.woff2', SOLID_ICONS],
      ['fa-brands-400.woff2', 'fa-brands-subset.woff2', BRAND_ICONS],
    ] as const) {
      const text = String.fromCodePoint(...codepointsFor(names, codepoints));
      const woff2 = await subsetFont(fa(`webfonts/${font}`), text, { targetFormat: 'woff2' });
      expect(Buffer.compare(Buffer.from(woff2), readFileSync(join(styles, 'fa', out)))).toBe(0);
    }
  });

  it('keeps the subset small', () => {
    const solid = statSync(join(styles, 'fa', 'fa-solid-subset.woff2')).size;
    const brands = statSync(join(styles, 'fa', 'fa-brands-subset.woff2')).size;
    expect(solid + brands).toBeLessThan(30_000);
  });

  it('shows a solid name outside the subset as the fallback icon', () => {
    const code = codepoints.get(FALLBACK_ICON)!.toString(16);
    expect(css).toContain(`.fa-solid::before {\n  content: var(--fa, '\\${code}');`);
    expect(UI_ICONS).toContain(FALLBACK_ICON);
  });
});

describe('pointIcon', () => {
  it('keeps a shipped icon, defaults an unset one, and falls back for an unknown name', () => {
    expect(pointIcon('utensils')).toBe('utensils');
    expect(pointIcon('compress')).toBe('compress');
    expect(pointIcon(undefined)).toBe('info');
    expect(pointIcon(null)).toBe('info');
    expect(pointIcon('anchor')).toBe(FALLBACK_ICON);
  });
});

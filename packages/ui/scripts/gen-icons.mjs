// Regenerates the Font Awesome subset: styles/fa/*.woff2 and styles/icons.css, from the
// icon lists in src/icons/names.ts. Run on demand after changing a list, and commit
// the output:
//
//   pnpm --filter @internal/ui gen:icons
//
// Node strips the TypeScript types of the two import-free src/icons modules.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import subsetFont from 'subset-font';

import { codepointsFor, faCodepoints, iconsCss } from '../src/icons/css.ts';
import { BRAND_ICONS, FALLBACK_ICON, SOLID_ICONS } from '../src/icons/names.ts';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(pkg, 'package.json'));
const faDir = dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
const fa = (path) => readFileSync(join(faDir, path));

const { version } = JSON.parse(fa('package.json').toString());
const codepoints = faCodepoints(
  fa('css/fontawesome.min.css').toString() + fa('css/brands.min.css').toString(),
);
const solid = [...SOLID_ICONS];
const brands = [...BRAND_ICONS];

async function subset(font, names, out) {
  const text = String.fromCodePoint(...codepointsFor(names, codepoints));
  const woff2 = await subsetFont(fa(`webfonts/${font}`), text, { targetFormat: 'woff2' });
  writeFileSync(join(pkg, 'styles/fa', out), woff2);
  stdout.write(`${out}: ${names.length} icons, ${woff2.length} bytes\n`);
}

await subset('fa-solid-900.woff2', solid, 'fa-solid-subset.woff2');
await subset('fa-brands-400.woff2', brands, 'fa-brands-subset.woff2');
writeFileSync(
  join(pkg, 'styles/icons.css'),
  iconsCss({ solid, brands, codepoints, fallback: FALLBACK_ICON, version }),
);
stdout.write('styles/icons.css written\n');

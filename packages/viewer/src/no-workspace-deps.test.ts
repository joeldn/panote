import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @panote/viewer is a standalone viewer: nothing it ships may depend on
// another workspace package. The eslint rule in eslint.config.ts catches an
// import as it is written; this catches the package.json side too.

const root = join(import.meta.dirname, '..');

// `from '@x/…'` (imports and re-exports), `import('@x/…')`, and a bare
// side-effect `import '@x/…'`.
const WORKSPACE_IMPORT =
  /from\s*['"]@(panote|internal)\/|import\s*\(\s*['"]@(panote|internal)\/|import\s*['"]@(panote|internal)\//;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('no workspace runtime dependencies', () => {
  it('lists no dependencies or peerDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('imports no @panote/* or @internal/* module outside tests', () => {
    const files = sources(join(root, 'src'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => WORKSPACE_IMPORT.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it.each([
    "import { x } from '@panote/core';",
    'export * from "@internal/contracts";',
    "const m = await import('@panote/core');",
    "import '@panote/core/side-effect';",
    'import"@internal/x"',
  ])('catches %s', (line) => {
    expect(WORKSPACE_IMPORT.test(line)).toBe(true);
  });

  it.each(["import { x } from './panote.js';", "// see '@panote/core'", "import '@panotes/x';"])(
    'lets %s through',
    (line) => {
      expect(WORKSPACE_IMPORT.test(line)).toBe(false);
    },
  );
});

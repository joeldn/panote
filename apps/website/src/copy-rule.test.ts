// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Copy rule (docs/design/NOTES.md): free, not open source; no export/download promises.
const BANNED = /open[\s-]*source|\bmit\b|github|export|download/i;
const SRC = new URL('.', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Every piece of text a user could see: string/template literals and JSX text. */
function copyIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    // Module specifiers are code, not copy.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('copy rule', () => {
  const files = sourceFiles(SRC);

  it('scans the website sources', () => {
    expect(files.some((f) => f.endsWith('landing/content.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('legal/Legal.tsx'))).toBe(true);
  });

  it('flags banned words', () => {
    for (const bad of ['Open source', 'MIT licence', 'on GitHub', 'Export tours', 'download'])
      expect(BANNED.test(bad)).toBe(true);
    expect(BANNED.test('No limits, submit')).toBe(false);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))('%s has no banned copy', (_, file) => {
    expect(copyIn(file).filter((text) => BANNED.test(text))).toEqual([]);
  });
});

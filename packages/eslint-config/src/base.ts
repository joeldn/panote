import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { commonIgnores } from './ignores.js';

/**
 * Paths that are never linted anywhere in the monorepo.
 *
 * Exported so that a consuming config can splice in extra ignores without
 * losing these.
 */
export { commonIgnores };

/**
 * Base flat config: ESLint recommended + typescript-eslint recommended, with
 * Prettier's rule-disabling config applied last.
 *
 * `eslint-config-prettier` only turns formatting rules OFF. Prettier itself is
 * run directly (`pnpm format` / `pnpm format:check`) rather than through
 * `eslint-plugin-prettier`, so formatting failures surface as formatting
 * failures instead of as thousands of lint errors.
 */
export const base = tseslint.config(
  { ignores: commonIgnores },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.es2023,
      },
    },
    rules: {
      // Allow deliberately-unused names when prefixed with an underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `import type` / `export type` must be explicit: isolatedModules and
      // verbatimModuleSyntax are on, so an accidental value import of a
      // type-only module is a runtime error waiting to happen.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
);

/**
 * Base config plus Node globals. Use for build tooling, scripts, and anything
 * that genuinely runs on Node (not workerd).
 */
export const node = tseslint.config(base, {
  languageOptions: {
    globals: {
      ...globals.node,
    },
  },
});

export default base;

import { commonIgnores, node } from '@internal/eslint-config';
import tseslint from 'typescript-eslint';

/**
 * Root ESLint flat config for the whole monorepo.
 *
 * Authored in TypeScript and loaded by ESLint via `jiti`. The actual rules live
 * in the built `@internal/eslint-config` package so that every workspace shares
 * one definition; this file only layers on repo-wide ignores and the handful of
 * overrides that only make sense at the root.
 *
 * Packages that need something different (e.g. the React SPAs in `apps/*`)
 * ship their own `eslint.config.ts` importing `@internal/eslint-config/react`.
 */
export default tseslint.config(
  {
    ignores: [...commonIgnores, '.changeset/**', '.turbo/**', '.wrangler/**', 'pnpm-lock.yaml'],
  },
  node,
  {
    // @panote/viewer is a standalone viewer: no runtime dependency on any
    // workspace package. Tests may import @panote/core to check parity with
    // the tiler's conventions (it is a devDependency for that alone).
    files: ['packages/viewer/src/**/*.ts'],
    ignores: ['packages/viewer/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@panote/*', '@internal/*'],
              message:
                '@panote/viewer has no workspace runtime dependencies; vendor what you need (design rule 1).',
            },
          ],
        },
      ],
    },
  },
  {
    // Root-level tooling config files are allowed to use default exports and
    // to reach for devDependencies.
    files: ['*.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);

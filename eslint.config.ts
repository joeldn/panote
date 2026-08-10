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
    // Root-level tooling config files are allowed to use default exports and
    // to reach for devDependencies.
    files: ['*.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);

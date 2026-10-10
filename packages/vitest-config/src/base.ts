import { defineConfig } from 'vitest/config';

/**
 * Workspace packages publish a `source` export condition that points at
 * `src/`. Resolving it first makes tests import a sibling package's current
 * source instead of its `dist/`, which goes stale between builds and caused
 * false failures in direct `vitest run`s. Builds and `tsc` ignore the
 * condition and keep using `dist/`.
 *
 * Vitest's node environment resolves through Vite's SSR environment and the
 * jsdom one through the client environment, so both lists are set. Setting a
 * list replaces Vite's defaults, so each one repeats them (Vite's
 * `defaultClientConditions` and `defaultServerConditions`, copied rather than
 * imported because this package does not depend on `vite` directly).
 */
const SOURCE_CONDITION = 'source';
const CLIENT_CONDITIONS = ['module', 'browser', 'development|production'];
const SERVER_CONDITIONS = ['module', 'node', 'development|production'];

/**
 * Shared Vitest base.
 *
 * Consumers merge it rather than extend it:
 *
 * ```ts
 * import { defineConfig, mergeConfig } from 'vitest/config';
 * import { baseConfig } from '@internal/vitest-config';
 *
 * export default mergeConfig(
 *   baseConfig,
 *   defineConfig({ test: { name: '@panote/core' } }),
 * );
 * ```
 *
 * NOTE for a later wave: the Cloudflare Workers packages (`services/*`) must
 * NOT use this config as-is. They need `@cloudflare/vitest-pool-workers` so
 * tests execute inside workerd, and `@vitest/coverage-v8` does not work under
 * workerd - those packages therefore run their tests WITHOUT coverage, and the
 * repo-level coverage story covers only the Node/browser packages.
 */
export const baseConfig = defineConfig({
  resolve: {
    conditions: [SOURCE_CONDITION, ...CLIENT_CONDITIONS],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...SERVER_CONDITIONS],
    },
  },
  test: {
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/.wrangler/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: [
        '**/*.d.ts',
        '**/*.{test,spec}.?(c|m)[jt]s?(x)',
        '**/__fixtures__/**',
        '**/__mocks__/**',
      ],
    },
  },
});

export default baseConfig;

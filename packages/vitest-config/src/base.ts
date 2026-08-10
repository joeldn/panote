import { defineConfig } from 'vitest/config';

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

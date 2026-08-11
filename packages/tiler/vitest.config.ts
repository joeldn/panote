import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Coverage is scoped to the pure math (`remap.ts`, `pyramid.ts`) rather than the
 * whole package. `build.ts` and `cli.ts` are thin sharp/FS/argv orchestration -
 * unit-testing them would mostly mean asserting that mocks were called, and they
 * are covered end-to-end by an actual tiling run.
 *
 * The source package expressed this as an `include` whitelist
 * (`['src/remap.ts', 'src/pyramid.ts']`) because its vitest.config.ts was
 * standalone. Here, `mergeConfig` CONCATENATES array fields rather than
 * replacing them (verified against the shared base's `coverage.include:
 * ['src/**']` - overriding `include` only widens it, it does not narrow it),
 * so the same scoping is expressed as an `exclude` addition instead, which is
 * concat-safe.
 */
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@internal/tiler',
      coverage: {
        exclude: ['src/index.ts', 'src/build.ts', 'src/cli.ts'],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

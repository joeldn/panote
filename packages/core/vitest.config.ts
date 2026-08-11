import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Pure math, no I/O, no DOM - the Node variant with nothing added.
 *
 * The `index.ts` barrel is excluded from coverage because it contains only
 * `export *` re-exports; counting it drags the ratio without measuring anything.
 */
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@panote/core',
      coverage: {
        exclude: ['src/index.ts'],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

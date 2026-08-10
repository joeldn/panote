import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Node, not workerd - deliberately, and it is the reason this package exists as a
 * package. Auth, bearer parsing, the error mapper and presigning are all pure
 * Web-standard code that Node 24 runs natively, so they get real coverage. Coverage
 * is impossible under the Workers pool (@vitest/coverage-v8 needs node:inspector),
 * so anything tested only there is untestable-with-coverage by construction.
 *
 * `src/r2-binding.ts` is the one module that genuinely needs a live R2 binding. It
 * is excluded from coverage here and covered from @service/admin-api's workerd
 * suite instead (see the port spec, section 4.5).
 */
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@internal/worker-kit',
      coverage: {
        exclude: ['src/index.ts', 'src/r2-binding.ts'],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

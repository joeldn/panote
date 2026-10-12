import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Node, not jsdom - deliberately.
 *
 * Most tests exercise pure functions (projection math, camera math, LRU
 * eviction). The ones that drive DOM- or GL-owning code (PanoViewer, the GL
 * renderer) stub just the `window`, `document` and canvas surface they touch
 * with small fakes instead of a full jsdom, and no module has a top-level DOM
 * side effect, so everything imports cleanly under Node.
 *
 * The coverage `exclude` list is the files with no statements to cover: the
 * entry point's re-exports and the type-only modules, plus the test-support
 * helpers, which are test code. `exclude` is used (not
 * `include`) because `mergeConfig` CONCATENATES array fields rather than
 * replacing them - an `include` here would only widen the base's `src/**`,
 * not narrow it, silently pulling untested files into the coverage
 * denominator. `exclude` is concat-safe.
 */
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@panote/viewer',
      coverage: {
        exclude: ['src/index.ts', 'src/types.ts', 'src/api.ts', 'src/test-support/**'],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

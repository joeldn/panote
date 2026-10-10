import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Node, not jsdom - deliberately.
 *
 * Most tests exercise pure functions (projection math, camera math, LRU
 * eviction, markdown rendering). The few that drive DOM- or GL-owning code
 * (PanoViewer, the GL renderer) stub just the `window`, `document` and canvas
 * surface they touch with small fakes instead of a full jsdom, and no module
 * has a top-level DOM side effect, so everything imports cleanly under Node.
 *
 * The coverage `exclude` list is the DOM/GL surface that has no unit tests: it is
 * exercised by running the viewer, not by assertions about mocks. `exclude` is
 * used (not `include`) because `mergeConfig` CONCATENATES array fields rather
 * than replacing them - an `include` here would only widen the base's
 * `src/**`, not narrow it, silently pulling untested files into the coverage
 * denominator. `exclude` is concat-safe.
 */
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@panote/viewer',
      coverage: {
        exclude: [
          'src/index.ts',
          'src/types.ts',
          'src/PanoViewer.ts',
          'src/render/gl-renderer.ts',
          'src/ui/index.ts',
        ],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Node, not jsdom - deliberately.
 *
 * Every test in this package exercises pure functions (projection math, camera
 * math, LRU eviction, markdown rendering, share-URL building). None touches
 * `document`, `window`, or a WebGL context, and no module has a top-level DOM
 * side effect, so the DOM-owning modules import cleanly under Node.
 *
 * When the first DOM-level test lands, switch to
 * `@internal/vitest-config/browser` and add `jsdom` to devDependencies.
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
          'src/tile-layer.ts',
          'src/controls.ts',
          'src/hotspots.ts',
          'src/render/gl-renderer.ts',
          'src/ui/index.ts',
          'src/ui/controls.ts',
          'src/ui/nav-arrows.ts',
          'src/ui/share-ui.ts',
          'src/ui/info-hotspots.ts',
        ],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

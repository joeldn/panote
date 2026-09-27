import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

// Node, not jsdom: XHR, fetch and timers are injected, so nothing here needs a DOM.
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@internal/web-kit',
      coverage: {
        exclude: ['src/index.ts'],
      },
    },
  }),
);

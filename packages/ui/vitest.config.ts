import { browserConfig } from '@internal/vitest-config/browser';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      name: '@internal/ui',
      coverage: {
        exclude: ['src/index.ts'],
      },
    },
  }),
);

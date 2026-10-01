import { browserConfig } from '@internal/vitest-config/browser';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      name: '@app/website',
      setupFiles: ['src/__fixtures__/setup.ts'],
      coverage: { exclude: ['src/main.tsx', 'src/__fixtures__/**'] },
    },
  }),
);

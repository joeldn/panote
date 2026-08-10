import { defineConfig, mergeConfig } from 'vitest/config';

import { baseConfig } from './base.js';

/**
 * Node-environment variant, for libraries and tooling that run on Node 24.
 */
export const nodeConfig = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'node',
    },
  }),
);

export default nodeConfig;

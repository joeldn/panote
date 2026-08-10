import { defineConfig, mergeConfig } from 'vitest/config';

import { baseConfig } from './base.js';

/**
 * Browser-ish variant for the React SPAs and the viewer package.
 *
 * Uses jsdom rather than Vitest's real-browser mode so it stays runnable in CI
 * without a browser install. The consuming package supplies `jsdom` itself; it
 * is deliberately not a dependency of this config package, so that Node-only
 * packages do not pay for it.
 */
export const browserConfig = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
    },
  }),
);

export default browserConfig;

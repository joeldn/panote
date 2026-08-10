import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Runs under Node even though the runtime target is workerd: everything here is
 * Web-standard (fetch, WebCrypto, atob/btoa), all of which Node 24 provides
 * natively. `jwks.test.ts` mints a real RS256 keypair through
 * `crypto.subtle.generateKey`, so this is genuine crypto, not a mock.
 *
 * No coverage thresholds. The source package never had any, and the measured
 * baseline (statements 88.9%, branches 78.6%, functions 88.9%) sits below the
 * 90/85/90/90 the other packages hold - the untested paths are `verifyJwt`'s
 * malformed-token branches. Adding a gate here would mean either failing CI on
 * day one or writing tests, and writing tests is not a port.
 */
export default mergeConfig(
  nodeConfig,
  defineConfig({
    test: {
      name: '@internal/contracts',
      coverage: {
        exclude: ['src/index.ts'],
      },
    },
  }),
);

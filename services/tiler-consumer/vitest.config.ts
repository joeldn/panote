import { defineWorkerTestConfig } from '@internal/vitest-config/workers';

// `environment: 'dev'` (the factory's default) is load-bearing - see
// @internal/vitest-config/src/workers.ts for why: every binding lives under
// [env.dev], so without it every binding-touching test fails.
export default defineWorkerTestConfig({
  name: '@service/tiler-consumer',
  cloudflareTestOptions: {
    // Secrets never appear in wrangler config; miniflare supplies them for
    // tests. Without these the Tiler DO's constructor (src/consumer.ts) would
    // throw from containerEnvVars() before the container-reaching cases in
    // consumer.test.ts ever get to exercise the "container not enabled in
    // this environment" failure mode they document.
    miniflare: {
      bindings: {
        R2_ACCESS_KEY_ID: 'test-access-key-id',
        R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
      },
    },
  },
});

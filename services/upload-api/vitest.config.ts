import { defineWorkerTestConfig } from '@internal/vitest-config/workers';

// `environment: 'dev'` (the factory's default) is load-bearing - see
// @internal/vitest-config/src/workers.ts for why: every binding lives under
// [env.dev], so without it env.R2_ACCOUNT_ID is undefined and every
// binding-touching test fails.
export default defineWorkerTestConfig({
  name: '@service/upload-api',
  cloudflareTestOptions: {
    // Secrets never appear in wrangler config; miniflare supplies them for tests.
    miniflare: {
      bindings: {
        R2_ACCESS_KEY_ID: 'test-access-key-id',
        R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
        // Opt-in for @internal/worker-kit's globalThis.__verifyJwt test seam -
        // see auth.ts. NEVER set this in wrangler.jsonc; it must stay confined to
        // the test-only miniflare bindings above.
        TEST_JWT_SEAM: 'enabled',
      },
    },
  },
});

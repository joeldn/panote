import { defineWorkerTestConfig } from '@internal/vitest-config/workers';

// `environment: 'dev'` (the factory's default) is load-bearing - see
// @internal/vitest-config/src/workers.ts for why: every binding lives under
// [env.dev], so without it env.BUCKET is undefined and every binding-touching
// test fails.
export default defineWorkerTestConfig({
  name: '@service/admin-api',
  cloudflareTestOptions: {
    miniflare: {
      bindings: {
        // Opt-in for @internal/worker-kit's globalThis.__verifyJwt test seam -
        // see auth.ts. NEVER set this in wrangler.jsonc; it must stay confined to
        // the test-only miniflare bindings here.
        TEST_JWT_SEAM: 'enabled',
      },
    },
  },
});

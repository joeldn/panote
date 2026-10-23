import { defineWorkerTestConfig } from '@internal/vitest-config/workers';

// The STATS binding points at public-api's TourStats class (script_name in
// wrangler.jsonc), so miniflare needs a Worker by that name to start at all.
// This stand-in speaks the same private protocol (services/public-api/src/stats.ts):
// POST /view counts, DELETE clears, anything else reads.
const STATS_STAND_IN = `
export class TourStats {
  constructor(state) { this.storage = state.storage; }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'DELETE') {
      await this.storage.deleteAll();
      return Response.json({ views: 0, likes: 0 });
    }
    const c = (await this.storage.get('counts')) ?? { views: 0, likes: 0 };
    if (req.method === 'POST' && url.pathname === '/view') {
      c.views++;
      await this.storage.put('counts', c);
    }
    return Response.json(c);
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

// `environment: 'dev'` (the factory's default) is load-bearing - see
// @internal/vitest-config/src/workers.ts for why: every binding lives under
// [env.dev], so without it env.BUCKET is undefined and every binding-touching
// test fails.
export default defineWorkerTestConfig({
  name: '@service/admin-api',
  // scripts/ holds the operator's account-delete CLI; its logic is pure enough for this pool.
  include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.test.ts'],
  cloudflareTestOptions: {
    miniflare: {
      bindings: {
        // Opt-in for @internal/worker-kit's globalThis.__verifyJwt test seam -
        // see auth.ts. NEVER set this in wrangler.jsonc; it must stay confined to
        // the test-only miniflare bindings here.
        TEST_JWT_SEAM: 'enabled',
        // A secret in a real env; operator.test.ts also runs without it.
        OPERATOR_TOKEN: 'test-operator-token',
      },
      // Every test reads and writes as the same few subs, far past the real limits:
      // lift them here. The 429 path is tested with a stubbed limiter instead.
      ratelimits: {
        WRITE_LIMITER: { namespace_id: '1301', simple: { limit: 1_000_000, period: 60 } },
        READ_LIMITER: { namespace_id: '1302', simple: { limit: 1_000_000, period: 60 } },
        INSIGHTS_LIMITER: { namespace_id: '1303', simple: { limit: 1_000_000, period: 60 } },
        OPERATOR_LIMITER: { namespace_id: '1304', simple: { limit: 1_000_000, period: 60 } },
        PANO_DELETE_LIMITER: { namespace_id: '1305', simple: { limit: 1_000_000, period: 60 } },
      },
      workers: [
        {
          name: 'panote-public-api-dev',
          modules: true,
          script: STATS_STAND_IN,
          durableObjects: { STATS: 'TourStats' },
        },
      ],
    },
  },
});

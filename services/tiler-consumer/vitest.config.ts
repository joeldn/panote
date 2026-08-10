import { defineWorkerTestConfig } from '@internal/vitest-config/workers';

// `environment: 'dev'` (the factory's default) is load-bearing - see
// @internal/vitest-config/src/workers.ts for why: every binding lives under
// [env.dev], so without it every binding-touching test fails.
export default defineWorkerTestConfig({ name: '@service/tiler-consumer' });

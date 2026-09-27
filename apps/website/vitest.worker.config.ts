import { defineWorkerTestConfig } from '@internal/vitest-config/workers';

// The /s/* redirect script runs in workerd; the SPA tests use vitest.config.ts (jsdom).
export default defineWorkerTestConfig({
  name: '@app/website worker',
  include: ['worker/**/*.test.ts'],
});

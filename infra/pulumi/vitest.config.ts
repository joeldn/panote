import { nodeConfig } from '@internal/vitest-config/node';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Unit tests run the program against Pulumi's mocks (no engine, no
 * provider, no Cloudflare). `src/index.ts` and `src/import-file-cli.ts` are
 * thin entry points over tested modules, so they are left out of coverage.
 *
 * The shared node config resolves the `module` export condition first.
 * `@opentelemetry/api` (pulled in by `@pulumi/pulumi`) points that condition
 * at an ESM build with extensionless imports, which Node can't load, so this
 * package drops it and resolves like Node does. mergeConfig concatenates
 * arrays, so the list is replaced here rather than merged.
 */
export default mergeConfig(
  {
    ...nodeConfig,
    ssr: { resolve: { conditions: ['source', 'node', 'development|production'] } },
  },
  defineConfig({
    test: {
      name: '@internal/infra',
      coverage: {
        exclude: ['src/index.ts', 'src/import-file-cli.ts'],
        thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  }),
);

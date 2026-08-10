import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// `cloudflareTest`'s parameter type (`WorkersPoolOptions`) is not exported by
// @cloudflare/vitest-pool-workers, only the function is. Derive it structurally
// instead of hand-duplicating the shape: the parameter is
// `WorkersPoolOptions | ((ctx) => ... )`, so stripping the function branch out
// of the union leaves the plain-object options type.
type CloudflareTestArg = Parameters<typeof cloudflareTest>[0];
type StripFunction<T> = T extends (...args: never[]) => unknown ? never : T;
type WorkersPoolOptions = StripFunction<CloudflareTestArg>;

const DEFAULT_INCLUDE = ['src/**/*.{test,spec}.ts'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/.wrangler/**'];

export interface WorkerTestConfigOptions {
  /** vitest `test.name` - identifies the project, e.g. '@service/public-api'. */
  readonly name: string;
  /**
   * Path to the wrangler config, relative to the consuming package.
   * Defaults to './wrangler.jsonc' - the one-file-per-Worker convention.
   */
  readonly wranglerConfigPath?: string;
  /**
   * wrangler environment to load bindings from. Defaults to 'dev'.
   *
   * LOAD-BEARING: every binding lives under `[env.dev]` in wrangler.jsonc, and
   * wrangler does NOT inherit top-level config into a named environment - so
   * without this, `env.BUCKET` / `env.STATS` / etc. are undefined and every
   * binding-touching test fails.
   */
  readonly environment?: string;
  /**
   * Extra cloudflareTest() options, merged in alongside the `wrangler` option
   * above (e.g. `miniflare: { bindings: {...} }` to inject secrets that never
   * appear in wrangler config - see @service/upload-api).
   */
  readonly cloudflareTestOptions?: Omit<WorkersPoolOptions, 'wrangler'>;
  /** Overrides `test.include`. Defaults to the standard Worker test glob. */
  readonly include?: string[];
  /** Overrides `test.exclude`. Defaults to the standard build-output excludes. */
  readonly exclude?: string[];
}

/**
 * Shared Vitest config factory for deployable Cloudflare Workers (`services/*`).
 *
 * Deliberately a separate entry point from this package's default export:
 * tests here run inside workerd via `@cloudflare/vitest-pool-workers`, and
 * `@vitest/coverage-v8` (which the default config's coverage block needs)
 * requires `node:inspector`, which workerd does not expose. A Worker package
 * must never merge the default `@internal/vitest-config` export - use this
 * factory instead.
 */
export function defineWorkerTestConfig(options: WorkerTestConfigOptions) {
  const {
    name,
    wranglerConfigPath = './wrangler.jsonc',
    environment = 'dev',
    cloudflareTestOptions,
    include = DEFAULT_INCLUDE,
    exclude = DEFAULT_EXCLUDE,
  } = options;

  return defineConfig({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: wranglerConfigPath, environment },
        ...cloudflareTestOptions,
      }),
    ],
    test: {
      name,
      clearMocks: true,
      restoreMocks: true,
      include,
      exclude,
    },
  });
}

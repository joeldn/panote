// Wrangler secrets never appear in wrangler.jsonc, so `wrangler types` cannot see
// them. Declaration-merge them into the generated global `Env` (used by src) and
// into `Cloudflare.Env` (which is what `cloudflare:test`'s `env` is typed as).
// The Tiler DO (src/consumer.ts) reads both of these at runtime in order to
// forward them to the container process via `envVars` - see src/container-env.ts.
interface Env {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}

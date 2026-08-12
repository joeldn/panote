// Wrangler secrets never appear in wrangler.jsonc, so `wrangler types` cannot see
// them. Declaration-merge them into the generated global `Env` (used by src) and
// into `Cloudflare.Env` (which is what `cloudflare:test`'s `env` is typed as).
// This file replaces the source repo's src/test-env.d.ts, whose `ProvidedEnv`
// augmentation is inert on pool 0.20.x - ProvidedEnv no longer exists.
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

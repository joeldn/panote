// Wrangler secrets never appear in wrangler.jsonc, so `wrangler types` cannot see
// them. Declaration-merge them into the generated global `Env` and `Cloudflare.Env`.
interface Env {
  CF_ANALYTICS_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    CF_ANALYTICS_TOKEN: string;
  }
}

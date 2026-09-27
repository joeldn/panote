// Wrangler secrets never appear in wrangler.jsonc, so `wrangler types` cannot see
// them. Declaration-merged into `Env` and `Cloudflare.Env` (upload-api pattern).
// Optional: unset means the CDN purge logs a warning and skips (B6).
interface Env {
  CF_PURGE_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    CF_PURGE_TOKEN?: string;
  }
}

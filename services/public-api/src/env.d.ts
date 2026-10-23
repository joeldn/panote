// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them (admin-api pattern).
// LIKER_HASH_KEY is optional: unset, TourStats hashes like dedupe keys without a key
// and logs a warning (see stats.ts).
interface Env {
  LIKER_HASH_KEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    LIKER_HASH_KEY?: string;
  }
}

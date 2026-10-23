// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them (admin-api pattern).
// LIKER_HASH_KEY is optional in dev: unset, TourStats hashes like dedupe keys without a
// key where the LIKER_HASH_FALLBACK var allows it, and refuses likes (503) elsewhere.
interface Env {
  LIKER_HASH_KEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    LIKER_HASH_KEY?: string;
  }
}

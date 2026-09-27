// `wrangler types --env dev` omits the inherited top-level assets binding.
interface Env {
  ASSETS: Fetcher;
}

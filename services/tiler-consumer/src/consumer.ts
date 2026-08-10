import { Container } from '@cloudflare/containers';

/**
 * Tile-building container DO. Full behaviour (envVars forwarding, defaultPort,
 * sleepAfter, the two `override` modifiers) lands in later commits; this stub
 * exists only so the package type-checks and `wrangler types` can generate
 * binding-exact runtime types for the TILER Durable Object namespace.
 */
export class Tiler extends Container<Env> {}

export default {
  async queue(): Promise<void> {
    // Queue consumer logic ported in a later commit.
  },
};

// Ported from crud-worker/src/stats.ts. Its request protocol (POST /view, POST
// /like?u=<who>, DELETE clears everything, anything else reads without mutating)
// is a private contract between this Worker and the DO, not a public API - see
// port spec section 3.3. No public route forwards a DELETE: only admin-api's
// account delete sends one, through its own STATS binding to this class.

// Most like dedupe keys (likedh:<hash>) one tour keeps. Past it, a new liker is
// no longer counted or stored, so storage stays bounded however many ids show up.
export const MAX_LIKES_PER_TOUR = 100_000;
// An Auth0 sub or a client UUID is far shorter; anything longer isn't a liker.
const MAX_LIKER_LENGTH = 256;

// A like's dedupe key holds a keyed hash of the liker, never the id itself: the
// key lives in someone else's tour, so a raw Auth0 sub there would outlive the
// liker's account deletion. HMAC-SHA-256 with the LIKER_HASH_KEY secret, so the
// stored value can't be matched to a sub without the secret. Changing the secret
// forgets who liked what (each liker can like once more), so it is set once.
const HASHED_PREFIX = 'likedh:';
// Before the hash, the key was liked:<who>, raw. Those are rewritten to the hashed
// form in batches (DO storage takes at most 128 keys a call), a batch per request
// until none are left, and a raw key still waiting counts as a like meanwhile.
// Nothing is stored to say they're done: a request that finds none only sets an
// in-memory flag, so a read (GET stats for any id, or after an account delete's
// DELETE) never creates state. A new instance lists once.
const LEGACY_PREFIX = 'liked:';
const MIGRATE_BATCH = 128;
// Without the secret, an env whose LIKER_HASH_FALLBACK var is "allow" (dev, and the
// tests) hashes with an unkeyed SHA-256 under a fixed domain prefix: likes keep
// working and no raw id is stored, but anyone who knows a sub could recompute its
// hash, so it is logged once. Any other env (production) fails closed: a like
// answers 503 and logs an error until the secret is set.
const UNKEYED_DOMAIN = 'panote:liker:v1:';
let warnedUnkeyed = false;

const textEncoder = new TextEncoder();
const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export const importLikerKey = (secret: string | undefined): Promise<CryptoKey | null> =>
  secret
    ? crypto.subtle.importKey(
        'raw',
        textEncoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    : Promise.resolve(null);

/** The dedupe hash of a liker id: HMAC-SHA-256 under `key`, or the unkeyed fallback. */
export const likerHash = async (who: string, key: CryptoKey | null): Promise<string> => {
  if (key) return toHex(await crypto.subtle.sign('HMAC', key, textEncoder.encode(who)));
  if (!warnedUnkeyed) {
    warnedUnkeyed = true;
    console.warn('LIKER_HASH_KEY is not set: like dedupe keys use an unkeyed hash');
  }
  return toHex(await crypto.subtle.digest('SHA-256', textEncoder.encode(UNKEYED_DOMAIN + who)));
};

interface Counts {
  views: number;
  likes: number;
}

export class TourStats {
  private state: DurableObjectState;
  private storage: DurableObjectStorage;
  private likerKey: Promise<CryptoKey | null>;
  private allowUnkeyed: boolean;
  private legacyMigrated = false;

  constructor(
    state: DurableObjectState,
    env: Partial<Pick<Env, 'LIKER_HASH_KEY' | 'LIKER_HASH_FALLBACK'>>,
  ) {
    this.state = state;
    this.storage = state.storage;
    this.likerKey = importLikerKey(env.LIKER_HASH_KEY);
    this.allowUnkeyed = env.LIKER_HASH_FALLBACK === 'allow';
  }

  // The liker's hash, or null when likes can't be hashed here (no secret, and the
  // env doesn't allow the unkeyed fallback).
  private async hash(who: string): Promise<string | null> {
    const key = await this.likerKey;
    if (!key && !this.allowUnkeyed) return null;
    return likerHash(who, key);
  }

  // One batch of raw liked:<who> keys rewritten as likedh:<hash>; true once none are
  // left. Hashing awaits crypto, which (unlike storage) doesn't hold the input gate,
  // so the batch runs inside blockConcurrencyWhile: no other request, an account
  // delete's DELETE included, can land between the list and the rewrite.
  private async migrateLegacyLikes(): Promise<boolean> {
    if (this.legacyMigrated) return true;
    return this.state.blockConcurrencyWhile(async () => {
      if (this.legacyMigrated) return true;
      const legacy = await this.storage.list({ prefix: LEGACY_PREFIX, limit: MIGRATE_BATCH });
      const hashed: Record<string, number> = {};
      for (const key of legacy.keys()) {
        const hash = await this.hash(key.slice(LEGACY_PREFIX.length));
        if (hash === null) return false; // No way to hash yet: leave them raw.
        hashed[`${HASHED_PREFIX}${hash}`] = 1;
      }
      if (legacy.size > 0) {
        await this.storage.put(hashed);
        await this.storage.delete([...legacy.keys()]);
      }
      if (legacy.size < MIGRATE_BATCH) this.legacyMigrated = true;
      return this.legacyMigrated;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'DELETE') {
      // Counts and every dedupe key, hashed or raw.
      await this.storage.deleteAll();
      this.legacyMigrated = false;
      return Response.json({ views: 0, likes: 0 });
    }
    const isLike = req.method === 'POST' && url.pathname === '/like';
    const raw = url.searchParams.get('u');
    const who = isLike && raw && raw.length <= MAX_LIKER_LENGTH ? raw : null;
    // Hashed before counts is read: from that read to its write only storage
    // operations may await, since the input gate only holds across those. A crypto
    // await in between would let two likes read the same count.
    const likeKey = who === null ? null : await this.hash(who);
    if (who !== null && likeKey === null) {
      console.error('LIKER_HASH_KEY is not set: refusing a like (fails closed off dev)');
      return Response.json({ error: 'likes unavailable' }, { status: 503 });
    }
    const migrated = await this.migrateLegacyLikes();
    const c = (await this.storage.get<Counts>('counts')) ?? { views: 0, likes: 0 };
    if (req.method === 'POST' && url.pathname === '/view') {
      c.views++;
      await this.storage.put('counts', c);
    } else if (who !== null && likeKey !== null && c.likes < MAX_LIKES_PER_TOUR) {
      const key = `${HASHED_PREFIX}${likeKey}`;
      const liked =
        (await this.storage.get(key)) ||
        (!migrated && (await this.storage.get(`${LEGACY_PREFIX}${who}`)));
      if (!liked) {
        c.likes++;
        await this.storage.put('counts', c);
        await this.storage.put(key, 1); // dedupe one like per user
      }
    }
    return Response.json(c);
  }
}

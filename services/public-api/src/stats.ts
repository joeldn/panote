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
const LEGACY_PREFIX = 'liked:';
const LEGACY_MIGRATED_KEY = 'likes-hashed';
const MIGRATE_BATCH = 128;
// Without the secret (local dev, or before it is set) the hash is an unkeyed
// SHA-256 with a fixed domain prefix: likes keep working and no raw id is stored,
// but anyone who knows a sub could recompute its hash, so it is logged once.
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
  private storage: DurableObjectStorage;
  private likerKey: Promise<CryptoKey | null>;
  private legacyMigrated = false;

  constructor(state: DurableObjectState, env: Pick<Env, 'LIKER_HASH_KEY'>) {
    this.storage = state.storage;
    this.likerKey = importLikerKey(env.LIKER_HASH_KEY);
  }

  private async hash(who: string): Promise<string> {
    return likerHash(who, await this.likerKey);
  }

  // One batch of raw liked:<who> keys rewritten as likedh:<hash>; true once none are left.
  private async migrateLegacyLikes(): Promise<boolean> {
    if (this.legacyMigrated) return true;
    if (await this.storage.get(LEGACY_MIGRATED_KEY)) {
      this.legacyMigrated = true;
      return true;
    }
    const legacy = await this.storage.list({ prefix: LEGACY_PREFIX, limit: MIGRATE_BATCH });
    if (legacy.size > 0) {
      const hashed: Record<string, number> = {};
      for (const key of legacy.keys()) {
        hashed[`${HASHED_PREFIX}${await this.hash(key.slice(LEGACY_PREFIX.length))}`] = 1;
      }
      await this.storage.put(hashed);
      await this.storage.delete([...legacy.keys()]);
    }
    if (legacy.size < MIGRATE_BATCH) {
      await this.storage.put(LEGACY_MIGRATED_KEY, true);
      this.legacyMigrated = true;
    }
    return this.legacyMigrated;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'DELETE') {
      // Counts and every dedupe key, hashed or raw.
      await this.storage.deleteAll();
      this.legacyMigrated = false;
      return Response.json({ views: 0, likes: 0 });
    }
    const migrated = await this.migrateLegacyLikes();
    const c = (await this.storage.get<Counts>('counts')) ?? { views: 0, likes: 0 };
    if (req.method === 'POST' && url.pathname === '/view') {
      c.views++;
      await this.storage.put('counts', c);
    } else if (req.method === 'POST' && url.pathname === '/like') {
      const who = url.searchParams.get('u');
      if (who && who.length <= MAX_LIKER_LENGTH && c.likes < MAX_LIKES_PER_TOUR) {
        const key = `${HASHED_PREFIX}${await this.hash(who)}`;
        const liked =
          (await this.storage.get(key)) ||
          (!migrated && (await this.storage.get(`${LEGACY_PREFIX}${who}`)));
        if (!liked) {
          c.likes++;
          await this.storage.put('counts', c);
          await this.storage.put(key, 1); // dedupe one like per user
        }
      }
    }
    return Response.json(c);
  }
}

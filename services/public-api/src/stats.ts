// Ported from crud-worker/src/stats.ts. Its request protocol (POST /view, POST
// /like?u=<who>, DELETE clears everything, anything else reads without mutating)
// is a private contract between this Worker and the DO, not a public API - see
// port spec section 3.3. No public route forwards a DELETE: only admin-api's
// account delete sends one, through its own STATS binding to this class.

// Most like dedupe keys (liked:<who>) one tour keeps. Past it, a new liker is
// no longer counted or stored, so storage stays bounded however many ids show up.
export const MAX_LIKES_PER_TOUR = 100_000;
// An Auth0 sub or a client UUID is far shorter; anything longer isn't a liker.
const MAX_LIKER_LENGTH = 256;

interface Counts {
  views: number;
  likes: number;
}

export class TourStats {
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'DELETE') {
      // Counts and every liked:<who> dedupe key.
      await this.storage.deleteAll();
      return Response.json({ views: 0, likes: 0 });
    }
    const c = (await this.storage.get<Counts>('counts')) ?? { views: 0, likes: 0 };
    if (req.method === 'POST' && url.pathname === '/view') {
      c.views++;
      await this.storage.put('counts', c);
    } else if (req.method === 'POST' && url.pathname === '/like') {
      const who = url.searchParams.get('u');
      if (
        who &&
        who.length <= MAX_LIKER_LENGTH &&
        c.likes < MAX_LIKES_PER_TOUR &&
        !(await this.storage.get(`liked:${who}`))
      ) {
        c.likes++;
        await this.storage.put('counts', c);
        await this.storage.put(`liked:${who}`, 1); // dedupe one like per user
      }
    }
    return Response.json(c);
  }
}

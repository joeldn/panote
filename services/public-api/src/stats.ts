// Ported from crud-worker/src/stats.ts, unchanged. Its request protocol (POST
// /view, POST /like?u=<who>, anything else reads without mutating) is a private
// contract between this Worker and the DO, not a public API - see port spec
// section 3.3.
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
    const c = (await this.storage.get<Counts>('counts')) ?? { views: 0, likes: 0 };
    if (req.method === 'POST' && url.pathname === '/view') {
      c.views++;
      await this.storage.put('counts', c);
    } else if (req.method === 'POST' && url.pathname === '/like') {
      const who = url.searchParams.get('u');
      if (who && !(await this.storage.get(`liked:${who}`))) {
        c.likes++;
        await this.storage.put('counts', c);
        await this.storage.put(`liked:${who}`, 1); // dedupe one like per user
      }
    }
    return Response.json(c);
  }
}

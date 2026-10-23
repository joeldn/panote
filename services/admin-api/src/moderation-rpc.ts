import { isContentId } from '@internal/contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { approvedToursUsing } from './explore.js';

// The Moderation entrypoint: what tiler-consumer asks of admin-api over its MODERATION
// service binding (RPC only: a named entrypoint has no HTTP route, so nothing outside the
// account can call it).
export class Moderation extends WorkerEntrypoint<Env> {
  /**
   * A tile job finished for this pano: every approved tour showing it goes back to the
   * operator's queue, since the approval was given before this image existed. How many.
   */
  async panoTiled(panoId: string): Promise<number> {
    if (!isContentId(panoId)) return 0;
    const tours = await approvedToursUsing(this.env.BUCKET, panoId);
    let revoked = 0;
    let failed = 0;
    // One tour failing doesn't stop the others; the caller hears about it after.
    for (const tourId of tours) {
      try {
        const stub = this.env.PUBLISHER.get(this.env.PUBLISHER.idFromName(tourId));
        if (await stub.revokeForPano(tourId, panoId)) revoked += 1;
      } catch (e) {
        failed += 1;
        console.error(
          `[explore] re-queue of tour ${tourId} failed:`,
          e instanceof Error ? e.name : 'unknown',
        );
      }
    }
    if (revoked > 0)
      console.warn(`[explore] pano ${panoId} re-tiled: ${revoked} tour(s) back in the queue`);
    if (failed > 0) throw new Error(`${failed} of ${tours.length} tour(s) not re-queued`);
    return revoked;
  }
}

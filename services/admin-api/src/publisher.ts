import {
  publishKey,
  pubTourKey,
  tourKey,
  type PublishedTour,
  type Visibility,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';
import { DurableObject } from 'cloudflare:workers';

import { parseHoldDays } from './account-age.js';
import { setExploreHidden, syncExplore } from './explore.js';
import {
  NOT_FOUND,
  parseAliasDays,
  publishTour,
  renameSlug,
  setVisibility,
  unpublish,
  type Clock,
  type Outcome,
  type PublishBody,
  type PublishRequest,
} from './publish.js';

// One instance per tourId: every publish-state change for that tour runs one at
// a time. The Worker authenticates `sub`; each operation re-proves ownership.
export class TourPublisher extends DurableObject<Env> {
  // Input gates don't stop interleaving across R2 awaits, so operations are
  // chained explicitly: each starts only after the previous one settled.
  private tail: Promise<unknown> = Promise.resolve();
  // Operations admitted to the queue; read by tests via runInDurableObject.
  queued = 0;

  private serial<T>(op: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const run = this.tail.then(op, op);
    this.tail = run.catch(() => undefined);
    return run;
  }

  // Checked before queueing so a non-owner can't delay the owner's operations;
  // each operation re-checks inside the queue too.
  private async owns(sub: string, tourId: string, orPublished = false): Promise<boolean> {
    if (await this.env.BUCKET.head(tourKey(sub, tourId))) return true;
    return orPublished && !!(await this.env.BUCKET.head(publishKey(sub, tourId)));
  }

  private clock(): Clock {
    return {
      now: new Date(),
      aliasDays: parseAliasDays(this.env.SLUG_ALIAS_DAYS),
      holdDays: parseHoldDays(this.env.NEW_ACCOUNT_HOLD_DAYS),
    };
  }

  async publish(sub: string, tourId: string, req: PublishRequest): Promise<Outcome<PublishBody>> {
    if (!(await this.owns(sub, tourId))) return NOT_FOUND;
    return this.serial(() => publishTour(this.env.BUCKET, sub, tourId, req, this.clock()));
  }

  async rename(
    sub: string,
    tourId: string,
    slug: string,
  ): Promise<Outcome<{ slug: string; oldSlugRedirectsUntil: string | null }>> {
    if (!(await this.owns(sub, tourId))) return NOT_FOUND;
    return this.serial(() => renameSlug(this.env.BUCKET, sub, tourId, slug, this.clock()));
  }

  async setVisibility(
    sub: string,
    tourId: string,
    visibility: Visibility,
  ): Promise<Outcome<{ visibility: Visibility }>> {
    if (!(await this.owns(sub, tourId))) return NOT_FOUND;
    return this.serial(() => setVisibility(this.env.BUCKET, sub, tourId, visibility, this.clock()));
  }

  // Returns the keys to purge; the Worker purges them so this queue stays fast.
  // `stopSharing`: also keep the editor's next Save from publishing it again.
  // `takedown`: an operator takedown, whose released slugs no owner may reclaim.
  async unpublish(
    sub: string,
    tourId: string,
    stopSharing = false,
    takedown = false,
  ): Promise<string[]> {
    if (!(await this.owns(sub, tourId, true))) return [];
    return this.serial(() => unpublish(this.env.BUCKET, sub, tourId, { stopSharing, takedown }));
  }

  // The operator's backfill (backfill.ts): re-syncs the tour's Explore entry from its live
  // bundle, in this queue like a publish. A tour listed for the first time this way takes its
  // last publish time as its place in the list, so a backfill doesn't put old tours on top.
  async refreshExplore(tourId: string): Promise<boolean> {
    return this.serial(async () => {
      const got = await getJson<PublishedTour>(this.env.BUCKET, pubTourKey(tourId));
      if (!got) return false;
      const now = Date.now();
      const publishedAt = Date.parse(got.value.publishedAt);
      const at = Number.isFinite(publishedAt) && publishedAt < now ? publishedAt : now;
      await syncExplore(this.env.BUCKET, got.value, new Date(at));
      return true;
    });
  }

  // The operator's hide from (or unhide on) Explore; the tour stays live by link.
  async setExploreHidden(sub: string, tourId: string, hidden: boolean): Promise<boolean> {
    if (!(await this.owns(sub, tourId, true))) return false;
    return this.serial(async () => {
      const bucket = this.env.BUCKET;
      const bundle = hidden ? null : await getJson<PublishedTour>(bucket, pubTourKey(tourId));
      await setExploreHidden(bucket, tourId, hidden, new Date(), bundle?.value ?? null);
      return true;
    });
  }
}

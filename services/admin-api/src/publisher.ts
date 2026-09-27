import { publishKey, tourKey, type Visibility } from '@internal/contracts';
import { DurableObject } from 'cloudflare:workers';

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
    return { now: new Date(), aliasDays: parseAliasDays(this.env.SLUG_ALIAS_DAYS) };
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

  async unpublish(sub: string, tourId: string): Promise<void> {
    if (!(await this.owns(sub, tourId, true))) return;
    return this.serial(() => unpublish(this.env.BUCKET, sub, tourId));
  }
}

import type { Visibility } from '@internal/contracts';
import { DurableObject } from 'cloudflare:workers';

import {
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

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private clock(): Clock {
    return { now: new Date(), aliasDays: parseAliasDays(this.env.SLUG_ALIAS_DAYS) };
  }

  publish(sub: string, tourId: string, req: PublishRequest): Promise<Outcome<PublishBody>> {
    return this.serial(() => publishTour(this.env.BUCKET, sub, tourId, req, this.clock()));
  }

  rename(
    sub: string,
    tourId: string,
    slug: string,
  ): Promise<Outcome<{ slug: string; oldSlugRedirectsUntil: string | null }>> {
    return this.serial(() => renameSlug(this.env.BUCKET, sub, tourId, slug, this.clock()));
  }

  setVisibility(
    sub: string,
    tourId: string,
    visibility: Visibility,
  ): Promise<Outcome<{ visibility: Visibility }>> {
    return this.serial(() => setVisibility(this.env.BUCKET, sub, tourId, visibility, this.clock()));
  }

  unpublish(sub: string, tourId: string): Promise<void> {
    return this.serial(() => unpublish(this.env.BUCKET, sub, tourId));
  }
}

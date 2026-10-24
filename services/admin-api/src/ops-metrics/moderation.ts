import type { OpsModeration } from '@internal/contracts';

import { listApprovalQueue } from '../explore.js';
import { listFlags } from '../flags.js';

// The moderation section: what waits for the operator, read the way the Explore queue
// (/app/ops/explore) and the flags review (/app/ops/flags) read it, so the counts match.

/** The longest-waiting tours shown on the dashboard; the queue page has the rest. */
export const MODERATION_OLDEST = 5;

export const moderationSection = async (bucket: R2Bucket): Promise<OpsModeration> => {
  const [queue, flags] = await Promise.all([listApprovalQueue(bucket), listFlags(bucket)]);
  // Flags are listed newest first (their keys rank by time).
  const newest = flags.flags[0];
  return {
    explore: {
      waiting: queue.length,
      changed: queue.filter((t) => t.reason === 'changed').length,
      oldest: queue.slice(0, MODERATION_OLDEST).map((t) => ({
        tourId: t.tourId,
        title: t.title,
        slug: t.slug,
        reason: t.reason,
        queuedAt: t.queuedAt,
      })),
    },
    flags: {
      viewer: flags.flags.filter((f) => f.source === 'viewer').length,
      screening: flags.flags.filter((f) => f.source === 'screening').length,
      more: flags.more,
      newestAt: newest?.at ?? null,
    },
  };
};

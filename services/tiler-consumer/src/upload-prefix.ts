import { PANO_PATTERN } from '@internal/contracts';

// Shape of a pano original's object-create notification key
// (packages/contracts/src/keys.ts's originalKey()): panos/<owner>/<panoId>/original.
// Anchored so this rejects a wrong segment count, but not either segment's
// charset - that's checked separately below, since the two segments have
// different rules.
const NOTIFICATION_KEY_RE = /^panos\/([^/]+)\/([^/]+)\/original$/;

// The owner segment is base64url (keys.ts's encodeId), which happens to share
// PANO_PATTERN's charset today. Kept as its own constant since the two
// segments are validated for different reasons and are free to diverge.
const OWNER_CHARSET_RE = /^[A-Za-z0-9_-]+$/;

export interface UploadTarget {
  /** The panoId segment, verbatim - what the tiler build()'s `pano` option must be. */
  readonly panoId: string;
}

/**
 * Derives the tile upload target from the R2 object-create notification key
 * the queue consumer forwards to the container.
 *
 * The owner segment is validated but not returned - tile/manifest output
 * is owner-free, keyed by panoId alone.
 */
export const deriveUploadTarget = (key: string): UploadTarget => {
  const match = NOTIFICATION_KEY_RE.exec(key);
  if (!match) {
    throw new Error(
      `tiler notification key must match panos/<owner>/<panoId>/original (got ${JSON.stringify(key)})`,
    );
  }
  const owner = match[1]!;
  const panoId = match[2]!;
  if (!OWNER_CHARSET_RE.test(owner)) {
    throw new Error(
      `tiler notification key owner segment must match ${OWNER_CHARSET_RE} (got ${JSON.stringify(owner)})`,
    );
  }
  if (!PANO_PATTERN.test(panoId)) {
    throw new Error(
      `tiler notification key panoId segment must match ${PANO_PATTERN} (got ${JSON.stringify(panoId)})`,
    );
  }
  return { panoId };
};

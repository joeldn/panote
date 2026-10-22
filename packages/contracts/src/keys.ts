import { PANO_PATTERN } from '@panote/core';

import { isValidSlug } from './slug.js';

// panoId/tourId are used verbatim, only checked against PANO_PATTERN,
// because the viewer builds tile/manifest URLs from the manifest's raw
// pano value - encoding them here would desync the tiler's key from
// that URL.
const assertValidId = (id: string, label: string): string => {
  if (!PANO_PATTERN.test(id)) {
    throw new Error(`${label} must match ${PANO_PATTERN} (got ${JSON.stringify(id)})`);
  }
  return id;
};

// The S3 path is percent-decoded while binding keys are literal, which
// is why the owner segment is base64url: encodeURIComponent output
// (e.g. "%7C") would resolve to two different physical keys depending
// on which access path wrote or read it.

// TextEncoder + btoa are standard in both workerd and Node; Buffer isn't
// guaranteed in workerd.
const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const textEncoder = new TextEncoder();

/**
 * Encodes the owner segment as base64url of its UTF-8 bytes, restricted
 * to URL-unreserved characters. See assertValidId above for why
 * panoId/tourId aren't encoded this way.
 */
export const encodeId = (raw: string): string => bytesToBase64Url(textEncoder.encode(raw));

export const panoPrefix = (u: string, p: string): string =>
  `panos/${encodeId(u)}/${assertValidId(p, 'panoId')}/`;
export const originalKey = (u: string, p: string): string => `${panoPrefix(u, p)}original`;
export const configKey = (u: string, p: string): string => `${panoPrefix(u, p)}config.json`;
// A tombstone left while a delete is in flight, so it's resumable: written
// first, deleted with the rest of the owner prefix last.
export const deletingKey = (u: string, p: string): string => `${panoPrefix(u, p)}deleting`;
// Written by the DLQ consumer (unit B4) on a permanent tiling failure,
// deleted on the next successful manifest swap. Read by admin-api's status.
export const tileFailedKey = (u: string, p: string): string => `${panoPrefix(u, p)}tile-failed`;

// Matches an R2 object-create notification key (owner already base64url-encoded,
// unlike panoPrefix's raw-owner input - see upload-prefix.ts's identical regex).
const ORIGINAL_KEY_RE = /^panos\/([^/]+)\/([^/]+)\/original$/;
// Same base64url charset as encodeId's output (upload-prefix.ts's OWNER_CHARSET_RE).
const OWNER_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

// Shared by both exports below - parses and validates both segments once.
// The errors never echo the key or the owner segment: callers log them, and
// the owner is base64url(sub), which is reversible.
const parseOriginalKey = (key: string): { owner: string; panoId: string } => {
  const match = ORIGINAL_KEY_RE.exec(key);
  if (!match) {
    throw new Error('tile-failed marker requires panos/<owner>/<panoId>/original');
  }
  const owner = match[1]!;
  const panoId = match[2]!;
  if (!OWNER_SEGMENT_RE.test(owner)) {
    throw new Error(`tile-failed marker owner segment must match ${OWNER_SEGMENT_RE}`);
  }
  if (!PANO_PATTERN.test(panoId)) {
    throw new Error(
      `tile-failed marker panoId segment must match ${PANO_PATTERN} (got ${JSON.stringify(panoId)})`,
    );
  }
  return { owner, panoId };
};

// Derives the tile-failed marker key from a notification key, without
// re-encoding the already-encoded owner segment; validates both segments.
export const tileFailedKeyFromOriginalKey = (key: string): string => {
  const { owner, panoId } = parseOriginalKey(key);
  return `panos/${owner}/${panoId}/tile-failed`;
};

// The panoId segment alone, validated the same way - unit B4's manifest
// race check needs it to build manifestKey(panoId).
export const panoIdFromOriginalKey = (key: string): string => parseOriginalKey(key).panoId;

export const userPanosPrefix = (u: string): string => `panos/${encodeId(u)}/`;
export const userToursPrefix = (u: string): string => `tours/${encodeId(u)}/`;
export const tourKey = (u: string, t: string): string =>
  `tours/${encodeId(u)}/${assertValidId(t, 'tourId')}/tour.json`;
// Private publish sidecar ({ slug, visibility, publishedAt }), never CDN-served.
export const publishKey = (u: string, t: string): string =>
  `tours/${encodeId(u)}/${assertValidId(t, 'tourId')}/publish.json`;
// Private marker ({ stoppedAt }) left by the owner's "Stop sharing": the editor's
// after-Save publish skips the tour while it exists; an explicit publish clears it.
export const sharingStoppedKey = (u: string, t: string): string =>
  `tours/${encodeId(u)}/${assertValidId(t, 'tourId')}/sharing-stopped.json`;
// Account deletion marker: written first, so the delete is resumable and the
// account read-only until it finishes. Owner-scoped like panos/ and tours/:
// the CDN's WAF rule only lets tiles/, pub/ and slugs/ through.
export const ACCOUNTS_ROOT = 'accounts/';
export const accountDeletionKey = (u: string): string =>
  `${ACCOUNTS_ROOT}${encodeId(u)}/deletion.json`;
// Operator takedown marker: while it exists the owner gets no upload URL and no
// admin write (403), like the deletion marker's 410. Only the operator script
// writes or removes it; account deletion leaves it, so a disabled owner stays so.
export const accountDisabledKey = (u: string): string =>
  `${ACCOUNTS_ROOT}${encodeId(u)}/disabled.json`;

// One empty object per upload URL that upload-api issued, for the per-owner daily
// upload limit: it counts URLs, so an upload that was deleted again, or a URL
// never used, still counts. Owner-scoped, outside panos/ (admin-api lists that as
// panos), and private: the CDN's WAF rule only lets tiles/, pub/ and slugs/
// through. The name is the issue time in basic ISO 8601 (no `:`, which the S3 and
// binding paths could spell differently) and the panoId.
export const UPLOAD_LOG_ROOT = 'upload-log/';
export const userUploadLogPrefix = (u: string): string => `${UPLOAD_LOG_ROOT}${encodeId(u)}/`;
const UPLOAD_LOG_STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;
export const uploadLogKey = (u: string, at: Date, p: string): string => {
  const stamp = at.toISOString().replace(/[-:.]/g, '');
  return `${userUploadLogPrefix(u)}${stamp}-${assertValidId(p, 'panoId')}`;
};
/** When an upload-log entry (the part after the owner prefix) was written, in epoch ms; NaN if malformed. */
export const uploadLogTime = (name: string): number => {
  const m = UPLOAD_LOG_STAMP_RE.exec(name.split('-', 1)[0] ?? '');
  if (!m) return NaN;
  const [, y, mo, d, h, mi, sec, ms] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}.${ms}Z`);
};

// Owner-free: base64url(sub) is reversible, so these must stay safe for a
// public bucket - panoId alone (a server-generated UUID) is unique enough.
export const TILES_ROOT = 'tiles/';
export const tilesPrefix = (p: string): string => `${TILES_ROOT}${assertValidId(p, 'panoId')}/`;
export const tileVersionPrefix = (p: string, v: string): string =>
  `${tilesPrefix(p)}${assertValidId(v, 'version')}/`;
export const manifestKey = (p: string): string => `${tilesPrefix(p)}manifest.json`;
// Alongside the tiles in the version dir, not next to the unversioned manifest.
export const previewKey = (p: string, v: string): string =>
  `${tileVersionPrefix(p, v)}preview.webp`;
// The link-preview image, same dir as preview.webp.
export const ogKey = (p: string, v: string): string => `${tileVersionPrefix(p, v)}og.jpg`;

// A tile version dir the tiler saw superseded by a manifest swap, waiting for
// admin-api's daily sweep to delete it after a grace period. Private: the CDN's
// WAF only lets tiles/, pub/ and slugs/ through, so the record may name the
// owner-bearing original key.
export const TILE_GC_ROOT = 'tile-gc/';
export const tileGcPrefix = (p: string): string => `${TILE_GC_ROOT}${assertValidId(p, 'panoId')}/`;
export const tileGcKey = (p: string, v: string): string =>
  `${tileGcPrefix(p)}${assertValidId(v, 'version')}.json`;

// Share links (plan 3.2): public and owner-free, same rule as tiles/ above.
export const PUB_TOURS_ROOT = 'pub/tours/';
export const pubTourKey = (t: string): string =>
  `${PUB_TOURS_ROOT}${assertValidId(t, 'tourId')}.json`;
export const SLUGS_ROOT = 'slugs/';
export const slugKey = (slug: string): string => {
  if (!isValidSlug(slug)) throw new Error(`invalid or reserved slug ${JSON.stringify(slug)}`);
  return `${SLUGS_ROOT}${slug}.json`;
};
// For a slug read back from storage: charset-checked against traversal but not
// re-validated, so a word reserved later still unpublishes. Null if unsafe.
const STORED_SLUG_RE = /^[a-z0-9-]{1,64}$/;
export const storedSlugKey = (slug: string): string | null =>
  STORED_SLUG_RE.test(slug) ? `${SLUGS_ROOT}${slug}.json` : null;

// Explore (the public discovery list): private, read only through public-api's
// GET /api/explore, never served raw (the CDN WAF rule only lets tiles/, pub/ and
// slugs/ through). Owner-free, like pub/: an entry may name a tour, never its owner.
export const EXPLORE_ROOT = 'explore/';
export const EXPLORE_INDEX_ROOT = `${EXPLORE_ROOT}index/`;
// R2 lists keys in ascending order, so an inverted timestamp lists newest first.
export const EXPLORE_RANK_MAX = 9_999_999_999_999;
const RANK_DIGITS = String(EXPLORE_RANK_MAX).length;
/** `<rank>-<tourId>`: an index entry's name, and the opaque cursor of the page after it. */
export const EXPLORE_CURSOR_PATTERN = /^\d{13}-[A-Za-z0-9_-]{1,64}$/;
export const exploreRank = (listedAtMs: number): string => {
  if (!Number.isSafeInteger(listedAtMs) || listedAtMs < 0 || listedAtMs > EXPLORE_RANK_MAX) {
    throw new Error(`listedAtMs out of range (got ${listedAtMs})`);
  }
  return String(EXPLORE_RANK_MAX - listedAtMs).padStart(RANK_DIGITS, '0');
};
/** One listed tour, newest-listed first: `explore/index/<rank>-<tourId>.json`. */
export const exploreEntryKey = (listedAtMs: number, tourId: string): string =>
  `${EXPLORE_INDEX_ROOT}${exploreRank(listedAtMs)}-${assertValidId(tourId, 'tourId')}.json`;
/** The entry key for a page cursor (see EXPLORE_CURSOR_PATTERN), or null if it isn't one. */
export const exploreCursorKey = (cursor: string): string | null =>
  EXPLORE_CURSOR_PATTERN.test(cursor) ? `${EXPLORE_INDEX_ROOT}${cursor}.json` : null;
/** The cursor naming an entry key, or null for a key outside the index. */
export const exploreCursorOf = (key: string): string | null => {
  if (!key.startsWith(EXPLORE_INDEX_ROOT) || !key.endsWith('.json')) return null;
  const name = key.slice(EXPLORE_INDEX_ROOT.length, -'.json'.length);
  return EXPLORE_CURSOR_PATTERN.test(name) ? name : null;
};
// Per-tour pointer ({ v, key }) at the tour's index entry, so removal finds it by tourId.
export const exploreTourKey = (t: string): string =>
  `${EXPLORE_ROOT}tours/${assertValidId(t, 'tourId')}.json`;
// Operator marker: the tour stays published by link but is never listed.
export const exploreHiddenKey = (t: string): string =>
  `${EXPLORE_ROOT}hidden/${assertValidId(t, 'tourId')}.json`;

export { PANO_PATTERN };

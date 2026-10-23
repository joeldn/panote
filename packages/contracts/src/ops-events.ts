// The operator event stream: one Workers Analytics Engine data point per thing that
// happens in the upload, tiling and publishing pipeline, written by every Worker through
// its OPS_EVENTS binding (worker-kit's recordOps) and read back by admin-api for the
// operator dashboard (docs/deploy.md, "Metrics dashboard"). Like the viewer events
// (analytics.ts), nothing in it identifies a person: no sub, email, IP, tour or pano id.
// Only the event name, a short detail from a fixed vocabulary and one number.

export const OPS_EVENTS_SCHEMA_VERSION = 'o1';

export const OPS_EVENT_NAMES = [
  /** upload-api handed out an upload URL. detail: new | replace | plan. value: bytes. */
  'upload-url',
  /** upload-api refused one. detail: a code (daily-limit, paused, ...), else status-<n>. */
  'upload-refused',
  /** tiler-consumer tiled an original. value: ms from job start to the container's answer. */
  'tile-ok',
  /** A tile job failed and will be tried again. detail: the container's status, or `threw`. */
  'tile-retry',
  /** A tile job that can never succeed. detail: oversize | unsupported | unprocessable-key. */
  'tile-refused',
  /** A tile job dead-lettered after its retries. */
  'tile-dead',
  /** A duplicate delivery skipped because the manifest already had that version. */
  'tile-skipped',
  /** admin-api writes. detail where noted. */
  'tour-created',
  /** detail: share (the owner shared or changed sharing) | save (a Save republished). */
  'tour-published',
  'tour-unpublished',
  'tour-deleted',
  'pano-deleted',
  /** detail: deleted | pending (the rest is swept later). */
  'account-deleted',
  'invite-created',
  'invite-accepted',
  /** Any Worker's rate limiter said no. detail: the limiter's binding name. */
  'rate-limited',
  /** public-api accepted a client error report. detail: the app (website | admin). */
  'client-error',
] as const;
export type OpsEventName = (typeof OPS_EVENT_NAMES)[number];

/** Short and from a known set at every call site, but capped anyway: it's an AE blob. */
export const MAX_OPS_DETAIL_LENGTH = 64;

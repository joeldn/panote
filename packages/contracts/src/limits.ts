/**
 * The `error` text of a refusal for an account or service limit. upload-api and admin-api
 * answer with these (403, or 503 for the service-wide pause), and the apps match on them,
 * so both sides read them from here.
 */
export const LIMIT_ERRORS = {
  /** admin-api: the owner has MAX_TOURS_PER_OWNER tours. */
  tours: 'tour limit reached',
  /** upload-api (and a transfer): the owner's pano count. */
  panos: 'pano limit reached',
  /** upload-api (and a transfer): the owner's bytes of originals. */
  storage: 'storage limit reached',
  /** upload-api: one tour's floor-plan images, which panos don't count toward. */
  planStorage: 'plan storage limit reached',
  /** upload-api: upload URLs one owner may get in a rolling 24 hours. */
  dailyUploads: 'daily upload limit reached',
  /** upload-api: the service-wide daily ceiling, until 00:00 UTC. */
  paused: 'uploads paused',
} as const;

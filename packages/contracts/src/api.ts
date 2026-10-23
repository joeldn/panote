import { z } from 'zod';

import { TILE_FORMATS } from './manifest.js';
import { MAX_LINKED_SUBS } from './jwt.js';
import { BACKUP_DATE_PATTERN, isRestorableKey, PANO_PATTERN } from './keys.js';
import { VisibilitySchema } from './publish.js';
import { SceneConfigSchema, TourDocSchema } from './schema.js';

// Response schemas for admin-api's owner GET routes; web-kit validates
// responses against these.

export const PanoConfigOkSchema = z.object({
  config: SceneConfigSchema,
  etag: z.string(),
});
export type PanoConfigOk = z.infer<typeof PanoConfigOkSchema>;

// Lets the UI tell a tombstoned pano apart from one whose config was
// simply never written, for the same missing-config 404.
export const PanoConfigNotFoundSchema = z.object({
  error: z.literal('config not found'),
  deleting: z.boolean(),
  hasOriginal: z.boolean(),
});
export type PanoConfigNotFound = z.infer<typeof PanoConfigNotFoundSchema>;

export const TourMissingConfigSchema = z.object({
  missing: z.literal(true),
  deleting: z.boolean(),
  hasOriginal: z.boolean(),
});
export type TourMissingConfig = z.infer<typeof TourMissingConfigSchema>;

export const TourConfigEntrySchema = z.union([PanoConfigOkSchema, TourMissingConfigSchema]);
export type TourConfigEntry = z.infer<typeof TourConfigEntrySchema>;

// The tour's share-link state (from its private publish.json), null when unpublished.
export const TourPublishStateSchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
  publishedAt: z.string(),
});
export type TourPublishState = z.infer<typeof TourPublishStateSchema>;

// The caller's part in a tour: its owner, or an editor the owner invited (members.ts).
export const TOUR_ROLES = ['owner', 'editor'] as const;
export const TourRoleSchema = z.enum(TOUR_ROLES);
export type TourRole = z.infer<typeof TourRoleSchema>;

export const TourOkSchema = z.object({
  tour: TourDocSchema,
  etag: z.string(),
  // Optional so clients stay compatible with responses from before B2.
  publish: TourPublishStateSchema.nullable().optional(),
  // Optional for the same reason: absent means the caller owns it, as before editors.
  role: TourRoleSchema.optional(),
});
export type TourOk = z.infer<typeof TourOkSchema>;

export const TourWithConfigsOkSchema = TourOkSchema.extend({
  configs: z.record(z.string(), TourConfigEntrySchema),
});
export type TourWithConfigsOk = z.infer<typeof TourWithConfigsOkSchema>;

export const TourNotFoundSchema = z.object({ error: z.literal('not found') });
export type TourNotFound = z.infer<typeof TourNotFoundSchema>;

// --- Lists, summaries and pano status (unit A2) ---

// Same order the tiling-status rule checks in: ready beats failed beats
// pending, so a same-etag race never shows a successfully tiled pano as failed.
export const TilingStatusSchema = z.enum(['ready', 'pending', 'failed', 'none']);
export type TilingStatus = z.infer<typeof TilingStatusSchema>;

// Loosely typed vs. ManifestSchema: this is read from our own tiler output,
// not re-validated, the same trust level tiler-consumer's own reads use.
export const PanoManifestSummarySchema = z.object({
  version: z.string().optional(),
  format: z.enum(TILE_FORMATS),
  tileSize: z.number().int().positive(),
  preview: z.literal(true).optional(),
});
export type PanoManifestSummary = z.infer<typeof PanoManifestSummarySchema>;

export const PanoSummarySchema = z.object({
  panoId: z.string(),
  title: z.string().nullable(),
  hasConfig: z.boolean(),
  hasOriginal: z.boolean(),
  deleting: z.boolean(),
  tiling: TilingStatusSchema,
  manifest: PanoManifestSummarySchema.nullable(),
  updatedAt: z.string(),
  // Only with `?include=references`: true when any of the owner's tours has
  // a scene on this pano. Absent means "not computed", never "unreferenced".
  referenced: z.boolean().optional(),
});
export type PanoSummary = z.infer<typeof PanoSummarySchema>;

export const PanosListOkSchema = z.object({
  panoIds: z.array(z.string()),
  panos: z.array(PanoSummarySchema),
  cursor: z.string().nullable(),
});
export type PanosListOk = z.infer<typeof PanosListOkSchema>;

// The pano GET's `status` field: PanoSummary minus the two fields already
// known from the surrounding response (panoId from the URL, title from config).
export const PanoStatusSchema = PanoSummarySchema.omit({
  panoId: true,
  title: true,
  referenced: true,
});
export type PanoStatus = z.infer<typeof PanoStatusSchema>;

// A separate schema from PanoConfigOkSchema: TourConfigEntrySchema still
// uses the bare {config, etag} shape for ?include=configs, unaffected here.
export const PanoWithStatusOkSchema = PanoConfigOkSchema.extend({ status: PanoStatusSchema });
export type PanoWithStatusOk = z.infer<typeof PanoWithStatusOkSchema>;

export const PanoStatusOnlyOkSchema = z.object({ status: PanoStatusSchema });
export type PanoStatusOnlyOk = z.infer<typeof PanoStatusOnlyOkSchema>;

// DELETE /api/admin/panos/:panoId refusals. `in-use`: a tour of the owner has
// a scene on it. `processing`: its original is still tiling. `recent`: it was
// uploaded too recently for an unfinished "add to tour" to be ruled out.
export const PANO_DELETE_CONFLICTS = {
  'in-use': 'pano is in use',
  processing: 'pano is processing',
  recent: 'pano was uploaded recently',
} as const;
export type PanoDeleteConflict = keyof typeof PANO_DELETE_CONFLICTS;

export const PanoDeleteConflictSchema = z.object({
  error: z.enum([
    PANO_DELETE_CONFLICTS['in-use'],
    PANO_DELETE_CONFLICTS.processing,
    PANO_DELETE_CONFLICTS.recent,
  ]),
});

export const TourPublishSummarySchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
});
export type TourPublishSummary = z.infer<typeof TourPublishSummarySchema>;

export const TourSummarySchema = z.object({
  tourId: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  coverPanoId: z.string().nullable(),
  updatedAt: z.string(),
  etag: z.string(),
  // From publish.json's customMetadata, grouped in by tourId; null when unpublished.
  publish: TourPublishSummarySchema.nullable(),
});
export type TourSummary = z.infer<typeof TourSummarySchema>;

export const ToursListOkSchema = z.object({
  tours: z.array(TourSummarySchema),
  cursor: z.string().nullable(),
});
export type ToursListOk = z.infer<typeof ToursListOkSchema>;

// --- Publish, slugs, visibility (unit B2) ---

export const PublishRequestSchema = z.object({
  visibility: VisibilitySchema.optional(),
  slug: z.string().optional(),
  // The editor's publish after a Save. Refused (409 'sharing stopped') once the
  // owner stopped sharing; a publish without it (the share modal's) shares again.
  afterSave: z.boolean().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const PublishOkSchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
  url: z.string(),
  publishedAt: z.string(),
});
export type PublishOk = z.infer<typeof PublishOkSchema>;

export const PUBLISH_FAILURE_REASONS = ['missing', 'deleting', 'not-owned', 'not-ready'] as const;
export const PublishFailureReasonSchema = z.enum(PUBLISH_FAILURE_REASONS);
export type PublishFailureReason = z.infer<typeof PublishFailureReasonSchema>;

// 422: every scene that failed its ownership/readiness check, not just the first.
export const PublishUnprocessableSchema = z.object({
  error: z.enum(['scenes not publishable', 'tour has no scenes']),
  scenes: z.array(z.object({ panoId: z.string(), reason: PublishFailureReasonSchema })),
});
export type PublishUnprocessable = z.infer<typeof PublishUnprocessableSchema>;

export const SlugTakenSchema = z.object({ error: z.literal('slug taken') });
// A bare publish whose current slug another tour now holds: retrying won't help,
// the user has to pick a new slug.
export const SlugLostSchema = z.object({ error: z.literal('slug lost') });
export const SlugInvalidSchema = z.object({ error: z.enum(['invalid slug', 'reserved slug']) });
// 409 when a concurrent publish, rename or visibility change got there first; retry.
export const PublishConflictSchema = z.object({ error: z.literal('conflict') });
export const NotPublishedSchema = z.object({ error: z.literal('not published') });
// 409 for a slug change while the tour already holds MAX_ALIASES (admin-api) redirect
// aliases; it works again once the oldest expires (SLUG_ALIAS_DAYS).
export const TooManyRenamesSchema = z.object({ error: z.literal('too many renames') });
// An after-Save publish of a tour whose owner stopped sharing it: nothing was published.
export const SharingStoppedSchema = z.object({ error: z.literal('sharing stopped') });

export const SlugPutRequestSchema = z.object({ slug: z.string() });
export const SlugPutOkSchema = z.object({
  slug: z.string(),
  // When the previous slug stops redirecting; null when the slug didn't change.
  oldSlugRedirectsUntil: z.string().nullable(),
});
export type SlugPutOk = z.infer<typeof SlugPutOkSchema>;

export const VisibilityPatchRequestSchema = z.object({ visibility: VisibilitySchema });
export const VisibilityOkSchema = z.object({ visibility: VisibilitySchema });
export type VisibilityOk = z.infer<typeof VisibilityOkSchema>;

// --- Tour insights (unit B5) ---

export const MIN_INSIGHTS_DAYS = 1;
export const MAX_INSIGHTS_DAYS = 30;
export const DEFAULT_INSIGHTS_DAYS = 14;

const count = () => z.number().int().nonnegative();

export const InsightsOkSchema = z.object({
  days: z.number().int().min(MIN_INSIGHTS_DAYS).max(MAX_INSIGHTS_DAYS),
  // ISO timestamps: `from` is 00:00 UTC of the first day, `to` is query time.
  from: z.string(),
  to: z.string(),
  totalViews: count(),
  avgDwellMs: z.number().nonnegative().nullable(),
  // One entry per UTC day, oldest first, zero-filled.
  daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), views: count() })),
  byPano: z.array(z.object({ panoId: z.string(), views: count() })),
  topHotspots: z.array(z.object({ panoId: z.string(), hotspotId: z.string(), opens: count() })),
});
export type InsightsOk = z.infer<typeof InsightsOkSchema>;

export const InsightsUnavailableSchema = z.object({ error: z.literal('analytics unavailable') });
export type InsightsUnavailable = z.infer<typeof InsightsUnavailableSchema>;

// --- Account deletion (unit E) ---

// What the owner types to confirm; the server checks it too, so a stray
// DELETE can't wipe an account.
export const ACCOUNT_DELETE_CONFIRMATION = 'delete my account';
export const AccountDeleteRequestSchema = z.object({
  confirm: z.literal(ACCOUNT_DELETE_CONFIRMATION),
});
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;

// 200 `deleted`: nothing is left. 202 `pending`: the account is marked and
// read-only, and admin-api's daily sweep removes the rest.
export const AccountDeleteOkSchema = z.object({ status: z.enum(['deleted', 'pending']) });
export type AccountDeleteOk = z.infer<typeof AccountDeleteOkSchema>;

// Account delete wants a sign-in this recent (the token's AUTH_TIME_CLAIM). The admin
// app asks Auth0 for one with `prompt=login` and the same `max_age` before retrying.
// Long enough to come back from Auth0 and type the phrase again.
export const RECENT_AUTH_MAX_AGE_SECONDS = 600;
// 403 from account delete when the sign-in isn't recent enough, or the token
// doesn't say when it was (the Auth0 Action that adds the claim isn't deployed).
export const REAUTH_REQUIRED_ERROR = 'reauthentication required';
export const ReauthRequiredSchema = z.object({ error: z.literal(REAUTH_REQUIRED_ERROR) });

// 410 from every owner write (and upload-url) once the account is marked.
export const AccountDeletedSchema = z.object({ error: z.literal('account deleted') });

// How many linked subs a deletion marker holds at most, across retries.
export const MARKER_MAX_LINKED_SUBS = MAX_LINKED_SUBS * 4;

// The marker at accountDeletionKey. `sub` lets the sweep rebuild the owner's keys.
export const AccountDeletionRecordSchema = z.object({
  v: z.literal(1),
  sub: z.string().min(1),
  requestedAt: z.string(),
  completedAt: z.string().optional(),
  // Identities linked into this user (the token's LINKED_SUBS_CLAIM): their
  // prefixes are deleted with the account's own. Retries can add to it, so it may
  // grow past one token's MAX_LINKED_SUBS; the bound only keeps the marker small.
  linkedSubs: z.array(z.string().min(1)).max(MARKER_MAX_LINKED_SUBS).optional(),
  // Linked subs an earlier, completed run already deleted. A retry that reopens the
  // delete for a new linked sub never deletes under these again: since completion,
  // one may have been unlinked and belong to a new, separate user.
  completedLinkedSubs: z.array(z.string().min(1)).max(MARKER_MAX_LINKED_SUBS).optional(),
});
export type AccountDeletionRecord = z.infer<typeof AccountDeletionRecordSchema>;

// The record at tileGcKey, overwritten by the tiler after every confirmed manifest
// swap. `tilerVersion` is the TILER_OUTPUT_VERSION of the job that superseded it,
// so the sweep can tell whether the current original would tile into this dir again.
export const TileGcRecordSchema = z.object({
  v: z.literal(1),
  originalKey: z.string().min(1),
  tilerVersion: z.number().int().nonnegative(),
  supersededAt: z.string(),
});
export type TileGcRecord = z.infer<typeof TileGcRecordSchema>;

// --- Operator takedown (abuse groundwork) ---

// 403 from every owner write (and upload-url) while the operator has the account disabled.
export const AccountDisabledSchema = z.object({ error: z.literal('account disabled') });

// The marker at accountDisabledKey. Written only by the operator script.
export const AccountDisabledRecordSchema = z.object({
  v: z.literal(1),
  disabledAt: z.string(),
  // The operator's own note (a ticket or the report's date); never shown to the owner.
  reason: z.string().max(500).optional(),
});
export type AccountDisabledRecord = z.infer<typeof AccountDisabledRecordSchema>;

// The pointer at tourOwnerKey: the owner of one tour, for the operator's takedown script.
export const TourOwnerRecordSchema = z.object({ v: z.literal(1), sub: z.string().min(1) });
export type TourOwnerRecord = z.infer<typeof TourOwnerRecordSchema>;

// quarantine/<caseId>/case.json: what an operator quarantine (takedown.ts) copied, and whose.
export const QuarantineCaseRecordSchema = z.object({
  v: z.literal(1),
  caseId: z.string(),
  sub: z.string().min(1),
  tourIds: z.array(z.string()),
  // The original keys copied; each copy is at quarantine/<caseId>/<key>.
  keys: z.array(z.string()),
  firstAt: z.string(),
  lastAt: z.string(),
  reason: z.string().optional(),
});
export type QuarantineCaseRecord = z.infer<typeof QuarantineCaseRecordSchema>;

// admin-api's operator-only takedown route, guarded by the OPERATOR_TOKEN secret
// sent in OPERATOR_TOKEN_HEADER. `delete` is the owner's own tour delete (it
// unpublishes first); `unpublish` only takes the share link, bundle and slug down.
// `hide` keeps the tour off Explore while it stays live by link; `unhide` undoes it.
export const OPERATOR_TAKEDOWN_PATH = '/api/admin/operator/takedown';
export const OPERATOR_TOKEN_HEADER = 'X-Operator-Token';
export const OPERATOR_TAKEDOWN_ACTIONS = ['unpublish', 'delete', 'hide', 'unhide'] as const;
export type OperatorTakedownAction = (typeof OPERATOR_TAKEDOWN_ACTIONS)[number];
export const OperatorTakedownRequestSchema = z.object({
  sub: z.string().min(1),
  tourId: z.string().regex(PANO_PATTERN),
  action: z.enum(OPERATOR_TAKEDOWN_ACTIONS),
});
export type OperatorTakedownRequest = z.infer<typeof OperatorTakedownRequestSchema>;
// What a CDN purge did, item by item (a prefix or a URL each). `purged`: Cloudflare took
// them. `pending`: they still failed after retries, or didn't fit in the request's budget,
// and admin-api's cron retries them every 15 minutes. `failed`: neither (not configured,
// refused outright and dead-lettered, or the queue couldn't be written). `status` sums it
// up: `failed` if any failed, else `pending` if any are queued; `none` had nothing to purge.
export const CDN_PURGE_STATUSES = ['none', 'purged', 'pending', 'failed', 'skipped'] as const;
export const CdnPurgeOutcomeSchema = z.object({
  status: z.enum(CDN_PURGE_STATUSES),
  purged: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type CdnPurgeOutcome = z.infer<typeof CdnPurgeOutcomeSchema>;
// 200: done. `purged` is a misnomer kept for older scripts: it is the number of purge
// targets PLANNED (public keys handed to the purge), not purged. What the purge actually
// did is `purge` (`purge.purged` went through).
export const OperatorTakedownOkSchema = z.object({
  action: z.enum(OPERATOR_TAKEDOWN_ACTIONS),
  /** Planned purge targets, whatever became of them; see `purge` for the outcome. */
  purged: z.number().int().nonnegative(),
  // Optional so this script still reads an admin-api deployed before it.
  purge: CdnPurgeOutcomeSchema.optional(),
});
export type OperatorTakedownOk = z.infer<typeof OperatorTakedownOkSchema>;

// admin-api's operator-only restore route (scripts/restore-backup.ts), same token as the
// takedown route. Copies each key back from backup/<date>/<key>; create-only unless
// `overwrite`. Keys are original keys, at most OPERATOR_RESTORE_MAX_KEYS per request.
export const OPERATOR_RESTORE_PATH = '/api/admin/operator/restore';
export const OPERATOR_RESTORE_MAX_KEYS = 100;
// Far past any key the app writes (an encoded owner, a tourId and a file name), and under
// R2's 1,024-byte key limit, so a request can't make the route build huge strings.
export const OPERATOR_RESTORE_MAX_KEY_LENGTH = 512;
export const OperatorRestoreRequestSchema = z.object({
  date: z.string().regex(BACKUP_DATE_PATTERN),
  keys: z
    .array(
      z
        .string()
        .max(OPERATOR_RESTORE_MAX_KEY_LENGTH)
        .refine(isRestorableKey, 'not a restorable key'),
    )
    .min(1)
    .max(OPERATOR_RESTORE_MAX_KEYS),
  overwrite: z.boolean().default(false),
});
export type OperatorRestoreRequest = z.infer<typeof OperatorRestoreRequestSchema>;
// 200: what happened to each key. `existing`: left as it is (create-only); `missing`: not
// in that day's set; `refused`: its owner's account is marked for deletion, or its owner
// can't be found (a public key whose tour has no owner pointer); `failed`: an R2 error, so
// worth another try.
export const OperatorRestoreOkSchema = z.object({
  restored: z.array(z.string()),
  existing: z.array(z.string()),
  missing: z.array(z.string()),
  refused: z.array(z.string()),
  failed: z.array(z.string()),
});
export type OperatorRestoreOk = z.infer<typeof OperatorRestoreOkSchema>;

// Written at backup/<date>/complete.json when a day's set is whole.
export const BackupCompleteRecordSchema = z.object({
  v: z.literal(1),
  date: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  objects: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  // Copies that failed, or objects over the size cap: not in this set.
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  runs: z.number().int().positive(),
});
export type BackupCompleteRecord = z.infer<typeof BackupCompleteRecordSchema>;
// backup/progress.json: the set being written, and the last key done in the current source.
// `lockedUntil`: the lease of the run writing it now; another run leaves the set alone until then.
export const BackupProgressSchema = BackupCompleteRecordSchema.omit({ completedAt: true }).extend({
  runs: z.number().int().nonnegative(),
  source: z.number().int().nonnegative(),
  startAfter: z.string().optional(),
  lockedUntil: z.string().optional(),
});
export type BackupProgress = z.infer<typeof BackupProgressSchema>;

// The anonymous like identity (X-Client-Id): what crypto.randomUUID() returns,
// a lowercase v4 UUID. public-api refuses anything else, so made-up ids can't
// be arbitrary strings, and the website replaces a stored id that isn't one.
export const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

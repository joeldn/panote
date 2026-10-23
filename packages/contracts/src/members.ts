import { z } from 'zod';

import { TourOwnerRecordSchema, TourRoleSchema, TourSummarySchema, type TourRole } from './api.js';
import { membersKey, PANO_PATTERN, tourKey, tourOwnerKey } from './keys.js';
import { isContentId } from './schema.js';

// Tour editors (docs/decisions.md, "Tour editors"). A tour has one owner, whose R2 prefix
// holds everything, and up to MAX_TOUR_MEMBERS editors and pending invites, listed in the
// owner's tours/<owner>/<tourId>/members.json. An editor's access is checked against that
// file on every request; nothing is copied into the editor's own prefix.

/** Editors plus pending invites, per tour. */
export const MAX_TOUR_MEMBERS = 10;
/** How long an invite link works. */
export const INVITE_DAYS = 7;
/** Tours one person may edit for others: each costs their dashboard a few reads. */
export const MAX_MEMBERSHIPS = 50;

// Lower case, like the token claim it is compared with (EMAIL_CLAIM in jwt.ts).
export const InviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'not an email address');

const IdSchema = z.string().regex(PANO_PATTERN);

export const TourMemberSchema = z.object({
  /** Opaque, for the owner's remove button; never the sub. */
  id: IdSchema,
  sub: z.string().min(1),
  email: z.string(),
  role: z.literal('editor'),
  addedAt: z.string(),
});
export type TourMember = z.infer<typeof TourMemberSchema>;

export const TourInviteSchema = z.object({
  id: IdSchema,
  email: z.string(),
  role: z.literal('editor'),
  /** sha256 of the token's secret, hex. The token itself is never stored. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TourInvite = z.infer<typeof TourInviteSchema>;

/** How long an offer to take over a tour stays open. */
export const TRANSFER_OFFER_DAYS = 7;

/** The owner's offer to make one of the tour's editors its owner. One at a time. */
export const TourTransferOfferSchema = z.object({
  memberId: IdSchema,
  offeredAt: z.string(),
  expiresAt: z.string(),
});
export type TourTransferOffer = z.infer<typeof TourTransferOfferSchema>;

export const TourMembersSchema = z.object({
  v: z.literal(1),
  /** The owner's verified email when they sent the first invite, for editors to see. */
  ownerEmail: z.string().nullable(),
  members: z.array(TourMemberSchema),
  invites: z.array(TourInviteSchema),
  transfer: TourTransferOfferSchema.optional(),
});
export type TourMembers = z.infer<typeof TourMembersSchema>;

export const EMPTY_MEMBERS: TourMembers = { v: 1, ownerEmail: null, members: [], invites: [] };

/** memberships/<editor>/<tourId>.json: which owner holds a tour the editor was added to. */
export const MembershipRecordSchema = z.object({ v: z.literal(1), owner: z.string().min(1) });
export type MembershipRecord = z.infer<typeof MembershipRecordSchema>;

/**
 * uploaded-for/<owner>/<panoId>.json: an editor uploaded this pano for `tourId`. An
 * editor may add a pano to a tour's scenes only when it is already there or has this record
 * for that tour, so an editor can't reach the owner's other panos by naming them.
 */
export const PanoUploadedForSchema = z.object({
  v: z.literal(1),
  tourId: z.string().min(1),
  sub: z.string().min(1),
});
export type PanoUploadedFor = z.infer<typeof PanoUploadedForSchema>;

// An invite token is `<tourId>.<secret>`: the tourId finds the tour (through its owner
// pointer), the secret proves the link. 32 random bytes, base64url.
const TOKEN_RE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;
export const InviteTokenSchema = z.string().regex(TOKEN_RE);

export const parseInviteToken = (token: string): { tourId: string; secret: string } | null => {
  const m = TOKEN_RE.exec(token);
  return m && isContentId(m[1]) ? { tourId: m[1], secret: m[2]! } : null;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A fresh token for `tourId`, and the hash to store for it. */
export const newInviteToken = async (
  tourId: string,
): Promise<{ token: string; tokenHash: string }> => {
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token: `${tourId}.${secret}`, tokenHash: await hashInviteSecret(secret) };
};

export const hashInviteSecret = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Reads for resolveTourAccess, so admin-api (R2 binding) and upload-api (S3 API) share
 * one rule. Both must throw rather than answer "missing" when R2 gives no clear answer.
 */
export interface AccessStore {
  exists(key: string): Promise<boolean>;
  /** The parsed JSON body, or null when there is no such object. */
  readJson(key: string): Promise<unknown>;
}

export type TourAccess = { owner: string; role: TourRole; members: TourMembers | null };

/**
 * Who `caller` is to `tourId`: its owner when tour.json is under their own prefix, an
 * editor when the tour's owner pointer (tour-owners/) names someone whose members.json
 * lists them, else null. The pointer is written create-only by the owner's own requests
 * and rewritten only by a change of owner the owner offered, and an editor is only ever
 * added by the owner it names, so neither can be forged by a caller. Account markers (deleted, disabled) are the caller's to check.
 */
export const resolveTourAccess = async (
  store: AccessStore,
  caller: string,
  tourId: string,
): Promise<TourAccess | null> => {
  if (!isContentId(tourId)) return null;
  if (await store.exists(tourKey(caller, tourId))) {
    return { owner: caller, role: 'owner', members: null };
  }
  const pointer = TourOwnerRecordSchema.safeParse(await store.readJson(tourOwnerKey(tourId)));
  if (!pointer.success || pointer.data.sub === caller) return null;
  const owner = pointer.data.sub;
  const members = TourMembersSchema.safeParse(await store.readJson(membersKey(owner, tourId)));
  if (!members.success || !members.data.members.some((m) => m.sub === caller)) return null;
  // members.json outlives nothing: tour delete removes it. Checked anyway, so a leftover
  // from an interrupted delete grants nothing.
  if (!(await store.exists(tourKey(owner, tourId)))) return null;
  return { owner, role: 'editor', members: members.data };
};

// --- Routes ---

export const InviteCreateRequestSchema = z.object({ email: InviteEmailSchema });

/** An invite as the owner's People list shows it: no hash. */
export const InviteViewSchema = TourInviteSchema.omit({ tokenHash: true });
export type InviteView = z.infer<typeof InviteViewSchema>;

/** The token is only ever in this response: the server keeps its hash. */
export const InviteCreateOkSchema = z.object({ invite: InviteViewSchema, token: z.string() });
export type InviteCreateOk = z.infer<typeof InviteCreateOkSchema>;

export const MemberViewSchema = TourMemberSchema.omit({ sub: true }).extend({
  /** This entry is the caller: an editor finds their own Leave button by it. */
  you: z.boolean(),
});
export type MemberView = z.infer<typeof MemberViewSchema>;

export const MembersOkSchema = z.object({
  role: TourRoleSchema,
  ownerEmail: z.string().nullable(),
  members: z.array(MemberViewSchema),
  /** Only for the owner; an editor sees no pending invites. */
  invites: z.array(InviteViewSchema),
  /** An open offer to make an editor the owner; the editor finds it by their member id. */
  transfer: TourTransferOfferSchema.omit({ offeredAt: true }).nullable().default(null),
});
export type MembersOk = z.infer<typeof MembersOkSchema>;

export const InviteAcceptRequestSchema = z.object({ token: InviteTokenSchema });
export const InviteAcceptOkSchema = z.object({ tourId: z.string() });
export type InviteAcceptOk = z.infer<typeof InviteAcceptOkSchema>;

// Why an accept was refused. `email` is the address the invite is for: whoever holds the
// link was sent it, so it tells them which account to sign in with.
export const INVITE_REFUSALS = [
  'invite not found',
  'invite expired',
  'no verified email',
  'wrong account',
  'own tour',
  'too many shared tours',
] as const;
export const InviteRefusedSchema = z.object({
  error: z.enum(INVITE_REFUSALS),
  email: z.string().optional(),
});
export type InviteRefused = z.infer<typeof InviteRefusedSchema>;

/** A tour on the editor's dashboard: the owner's summary, and whose it is. */
export const SharedTourSummarySchema = TourSummarySchema.extend({
  ownerEmail: z.string().nullable(),
});
export type SharedTourSummary = z.infer<typeof SharedTourSummarySchema>;

export const SharedToursOkSchema = z.object({ tours: z.array(SharedTourSummarySchema) });
export type SharedToursOk = z.infer<typeof SharedToursOkSchema>;

// --- Changing a tour's owner (docs/decisions.md, "Tour editors") ---

export const TransferOfferRequestSchema = z.object({ memberId: IdSchema });
export const TransferOfferOkSchema = z.object({
  transfer: TourTransferOfferSchema.omit({ offeredAt: true }),
});
export type TransferOfferOk = z.infer<typeof TransferOfferOkSchema>;

// Why taking over a tour was refused. The limits are the new owner's: the tour and its
// panos count toward them from then on.
export const TRANSFER_REFUSALS = [
  'no offer',
  'offer expired',
  'tour limit reached',
  'pano limit reached',
  'storage limit reached',
] as const;
export const TransferRefusedSchema = z.object({ error: z.enum(TRANSFER_REFUSALS) });
export type TransferRefused = z.infer<typeof TransferRefusedSchema>;
export const TransferAcceptOkSchema = z.object({ tourId: z.string() });
export type TransferAcceptOk = z.infer<typeof TransferAcceptOkSchema>;

/** 409 from every write to a tour while its owner is changing. */
export const TOUR_TRANSFERRING_ERROR = 'tour is changing owner';

/**
 * tour-transfers/<tourId>.json, written before anything moves and deleted once all of it
 * has. `panos` maps each of the tour's panoIds to its id in the new owner's account: the
 * same id when the pano moves, a fresh one when the old owner's other tours still use it
 * (a copy, tiled again from its original). Fixed when the record is written, so a resumed
 * transfer makes the same copies.
 */
export const TourTransferRecordSchema = z.object({
  v: z.literal(1),
  from: z.string().min(1),
  to: z.string().min(1),
  fromEmail: z.string().nullable(),
  toEmail: z.string().nullable(),
  startedAt: z.string(),
  panos: z.record(IdSchema, IdSchema),
});
export type TourTransferRecord = z.infer<typeof TourTransferRecordSchema>;

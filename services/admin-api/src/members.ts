import {
  EMPTY_MEMBERS,
  hashInviteSecret,
  INVITE_DAYS,
  MAX_MEMBERSHIPS,
  MAX_TOUR_MEMBERS,
  MembershipRecordSchema,
  PanoUploadedForSchema,
  membersKey,
  membershipKey,
  newInviteToken,
  isContentId,
  parseInviteToken,
  publishKey,
  resolveTourAccess,
  tourKey,
  tourOwnerKey,
  TourMembersSchema,
  uploadedForKey,
  TourOwnerRecordSchema,
  userMembershipsPrefix,
  type AccessStore,
  type InviteCreateOk,
  type InviteRefused,
  type MembersOk,
  type SharedTourSummary,
  type TourAccess,
  type TourMember,
  type TourMembers,
  type TourDoc,
  type TourOwnerRecord,
} from '@internal/contracts';
import { deletePrefix, getJson, putJson } from '@internal/worker-kit/r2-binding';

import { isAccountDeleted } from './delete-account.js';
import { resolveTourFields, toPublishSummary } from './lists.js';
import { isAccountDisabled } from './operator.js';

// Tour editors: who may do what to a tour (resolveTourAccess in contracts), the owner's
// members.json and the invites in it, and each editor's memberships/ index. Every
// members.json write is conditional on the ETag it read, so two owners' tabs (or an
// owner and an accepting editor) can't lose each other's change.

const DAY_MS = 24 * 60 * 60 * 1000;
// A members.json write that lost a race is redone from a fresh read this many times.
const MEMBERS_WRITE_ATTEMPTS = 3;

/** The access rule over the R2 binding. An unparsable body reads as missing. */
export const bindingStore = (bucket: R2Bucket): AccessStore => ({
  exists: async (key) => !!(await bucket.head(key)),
  readJson: async (key) => {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return obj.json().catch(() => null);
  },
});

export type AccessRefusal = { status: 403 | 404; error: string };

/**
 * The caller's access to `tourId`, or why not. An editor is refused while the owner's
 * account is being deleted (the tour is going), and refused writes while the operator has
 * the owner disabled, the same as the owner. `ownerOnly` refuses editors with a 403.
 */
export const tourAccessFor = async (
  bucket: R2Bucket,
  caller: string,
  tourId: string,
  opts: { write?: boolean; ownerOnly?: boolean } = {},
): Promise<TourAccess | AccessRefusal> => {
  const access = await resolveTourAccess(bindingStore(bucket), caller, tourId);
  if (!access) return { status: 404, error: 'not found' };
  if (access.role === 'owner') return access;
  if (opts.ownerOnly) return { status: 403, error: 'owner only' };
  const [deleted, disabled] = await Promise.all([
    isAccountDeleted(bucket, access.owner),
    opts.write ? isAccountDisabled(bucket, access.owner) : Promise.resolve(false),
  ]);
  if (deleted) return { status: 404, error: 'not found' };
  if (disabled) return { status: 403, error: 'owner account disabled' };
  return access;
};

export const isRefusal = (a: TourAccess | AccessRefusal): a is AccessRefusal => 'status' in a;

/**
 * Whether an editor uploaded `panoId` for `tourId` (upload-api's uploaded-for record). The
 * only owner's panos an editor may add to a tour's scenes, or reach before Save adds them.
 */
export const uploadedForTour = async (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
  panoId: string,
): Promise<boolean> => {
  const got = await getJson<unknown>(bucket, uploadedForKey(owner, panoId));
  const parsed = PanoUploadedForSchema.safeParse(got?.value);
  return parsed.success && parsed.data.tourId === tourId;
};

/**
 * The scenes an editor's tour PUT adds that they may not: every pano not already in the
 * saved tour must be one an editor uploaded for this tour. Otherwise an editor could name
 * any of the owner's panos (their ids are public) and then reach it through this tour.
 */
export const scenesEditorMayNotAdd = async (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
  saved: Pick<TourDoc, 'scenes'>,
  next: Pick<TourDoc, 'scenes'>,
): Promise<string[]> => {
  const had = new Set(saved.scenes.map((s) => s.panoId));
  const added = [...new Set(next.scenes.map((s) => s.panoId))].filter((id) => !had.has(id));
  const ok = await Promise.all(added.map((id) => uploadedForTour(bucket, owner, tourId, id)));
  return added.filter((_, i) => !ok[i]);
};

/**
 * Makes the tour-owners/ pointer name `owner`, who must already be proven to hold
 * tour.json. Editor access goes through it, so unlike recordTourOwner this one must
 * succeed: a pointer naming anyone else is left alone and refused (tourIds are only ever
 * one owner's, so that is a fault for the operator, never something to overwrite).
 */
export const claimTourOwner = async (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
): Promise<boolean> => {
  const record: TourOwnerRecord = { v: 1, sub: owner };
  const created = await putJson(bucket, tourOwnerKey(tourId), record, { etagDoesNotMatch: '*' });
  if (created.ok) return true;
  const got = await getJson<unknown>(bucket, tourOwnerKey(tourId));
  const parsed = TourOwnerRecordSchema.safeParse(got?.value);
  if (parsed.success) return parsed.data.sub === owner;
  // Unreadable: rewrite it, but only the copy just read.
  if (!got) return false;
  return (await putJson(bucket, tourOwnerKey(tourId), record, { etagMatches: got.etag })).ok;
};

const readMembers = async (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
): Promise<{ members: TourMembers; etag: string | null }> => {
  const got = await getJson<unknown>(bucket, membersKey(owner, tourId));
  if (!got) return { members: EMPTY_MEMBERS, etag: null };
  const parsed = TourMembersSchema.safeParse(got.value);
  // An unparsable file grants nothing (resolveTourAccess agrees) and is replaced on write.
  return { members: parsed.success ? parsed.data : EMPTY_MEMBERS, etag: got.etag };
};

type Change<T> = { members: TourMembers; result: T } | { refuse: T };

/**
 * Read, change, write members.json conditionally, redone from a fresh read when another
 * write got there first. `change` returning `refuse` writes nothing. A change that leaves
 * nobody and no invites still writes the (empty) file: R2 deletes aren't conditional, so a
 * delete could drop a write that raced it. The tour's delete removes the file.
 */
const updateMembers = async <T>(
  bucket: R2Bucket,
  owner: string,
  tourId: string,
  change: (current: TourMembers) => Change<T>,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    const { members, etag } = await readMembers(bucket, owner, tourId);
    const next = change(members);
    if ('refuse' in next) return next.refuse;
    const key = membersKey(owner, tourId);
    const onlyIf: R2Conditional = etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: etag };
    if ((await putJson(bucket, key, next.members, onlyIf)).ok) return next.result;
    if (attempt >= MEMBERS_WRITE_ATTEMPTS) throw new Error('members.json kept changing');
  }
};

const live = (members: TourMembers, nowMs: number): TourMembers => ({
  ...members,
  invites: members.invites.filter((i) => Date.parse(i.expiresAt) > nowMs),
});

/** GET …/members: the owner sees everything; an editor sees who else edits, no invites. */
export const membersView = (access: TourAccess, members: TourMembers): MembersOk => ({
  role: access.role,
  ownerEmail: members.ownerEmail,
  members: members.members.map(({ sub: _sub, ...rest }) => rest),
  invites:
    access.role === 'owner' ? members.invites.map(({ tokenHash: _hash, ...rest }) => rest) : [],
});

export const getMembers = async (
  bucket: R2Bucket,
  access: TourAccess,
  tourId: string,
): Promise<MembersOk> =>
  membersView(access, (await readMembers(bucket, access.owner, tourId)).members);

export type InviteOutcome =
  { status: 201; body: InviteCreateOk } | { status: 400 | 409 | 500; body: { error: string } };

/**
 * POST …/invites, owner only. A second invite to the same address replaces the first (a
 * fresh link; the old one stops working). Expired invites are dropped as it goes.
 */
export const createInvite = async (
  bucket: R2Bucket,
  owner: { sub: string; email: string | undefined },
  tourId: string,
  email: string,
  now: Date,
): Promise<InviteOutcome> => {
  if (email === owner.email) return { status: 400, body: { error: 'own email' } };
  if (!(await claimTourOwner(bucket, owner.sub, tourId))) {
    console.error(`[members] tour ${tourId} has an owner pointer that names someone else`);
    return { status: 500, body: { error: 'tour owner record mismatch' } };
  }
  const { token, tokenHash } = await newInviteToken(tourId);
  const invite = {
    id: crypto.randomUUID(),
    email,
    role: 'editor' as const,
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY_MS).toISOString(),
  };
  return updateMembers<InviteOutcome>(bucket, owner.sub, tourId, (current) => {
    const members = live(current, now.getTime());
    if (members.members.some((m) => m.email === email)) {
      return { refuse: { status: 409, body: { error: 'already an editor' } } };
    }
    const invites = members.invites.filter((i) => i.email !== email);
    if (members.members.length + invites.length >= MAX_TOUR_MEMBERS) {
      return { refuse: { status: 409, body: { error: 'tour full' } } };
    }
    const { tokenHash: _hash, ...view } = invite;
    return {
      members: {
        ...members,
        ownerEmail: owner.email ?? members.ownerEmail,
        invites: [...invites, invite],
      },
      result: { status: 201, body: { invite: view, token } },
    };
  });
};

/** DELETE …/invites/:inviteId, owner only. Idempotent. */
export const revokeInvite = (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
  inviteId: string,
): Promise<void> =>
  updateMembers<void>(bucket, owner, tourId, (current) =>
    current.invites.some((i) => i.id === inviteId)
      ? {
          members: { ...current, invites: current.invites.filter((i) => i.id !== inviteId) },
          result: undefined,
        }
      : { refuse: undefined },
  );

/**
 * DELETE …/members/:memberId: the owner removes an editor, or an editor removes
 * themselves (leaves). Idempotent; false when the caller may not remove that member.
 */
export const removeMember = async (
  bucket: R2Bucket,
  access: TourAccess,
  caller: string,
  tourId: string,
  memberId: string,
): Promise<boolean> => {
  const removed = await updateMembers<TourMember | null | false>(
    bucket,
    access.owner,
    tourId,
    (current) => {
      const member = current.members.find((m) => m.id === memberId);
      if (!member) return { refuse: null };
      if (access.role !== 'owner' && member.sub !== caller) return { refuse: false };
      return {
        members: { ...current, members: current.members.filter((m) => m.id !== memberId) },
        result: member,
      };
    },
  );
  if (removed === false) return false;
  if (removed) await bucket.delete(membershipKey(removed.sub, tourId));
  return true;
};

export type AcceptOutcome =
  | { status: 200; body: { tourId: string } }
  | { status: 403 | 404 | 409 | 410; body: InviteRefused };

const refused = (
  status: 403 | 404 | 409 | 410,
  error: InviteRefused['error'],
  email?: string,
): AcceptOutcome => ({ status, body: { error, ...(email !== undefined && { email }) } });

/**
 * POST /api/admin/invites/accept: turns a pending invite into an editor. The caller must
 * hold the link and be signed in with the address it was sent to (the verified email claim).
 * Accepting twice is fine; the second answer is the same.
 */
export const acceptInvite = async (
  bucket: R2Bucket,
  caller: { sub: string; email: string | undefined },
  token: string,
  now: Date,
): Promise<AcceptOutcome> => {
  const parsed = parseInviteToken(token);
  if (!parsed) return refused(404, 'invite not found');
  const { tourId, secret } = parsed;
  const pointer = TourOwnerRecordSchema.safeParse(
    (await getJson<unknown>(bucket, tourOwnerKey(tourId)))?.value,
  );
  if (!pointer.success) return refused(404, 'invite not found');
  const owner = pointer.data.sub;
  if (owner === caller.sub) return refused(409, 'own tour');
  // An owner being deleted, or disabled by the operator, takes on no new editors.
  const [tour, ownerDeleted, ownerDisabled] = await Promise.all([
    bucket.head(tourKey(owner, tourId)),
    isAccountDeleted(bucket, owner),
    isAccountDisabled(bucket, owner),
  ]);
  if (!tour || ownerDeleted || ownerDisabled) return refused(404, 'invite not found');
  const tokenHash = await hashInviteSecret(secret);

  // The index cap is checked before the write; a race past it costs one extra entry.
  const shared = await bucket.list({
    prefix: userMembershipsPrefix(caller.sub),
    limit: MAX_MEMBERSHIPS,
  });
  const atCap = shared.objects.length >= MAX_MEMBERSHIPS;

  const outcome = await updateMembers<AcceptOutcome>(bucket, owner, tourId, (current) => {
    const invite = current.invites.find((i) => i.tokenHash === tokenHash);
    if (!invite) {
      // Already accepted by this caller (a double click, a retry): the same answer.
      return current.members.some((m) => m.sub === caller.sub)
        ? { refuse: { status: 200, body: { tourId } } }
        : { refuse: refused(404, 'invite not found') };
    }
    if (Date.parse(invite.expiresAt) <= now.getTime()) {
      return { refuse: refused(410, 'invite expired', invite.email) };
    }
    if (caller.email === undefined)
      return { refuse: refused(403, 'no verified email', invite.email) };
    if (caller.email !== invite.email)
      return { refuse: refused(403, 'wrong account', invite.email) };
    const invites = current.invites.filter((i) => i.id !== invite.id);
    if (current.members.some((m) => m.sub === caller.sub)) {
      return { members: { ...current, invites }, result: { status: 200, body: { tourId } } };
    }
    if (atCap) return { refuse: refused(409, 'too many shared tours', invite.email) };
    const member: TourMember = {
      id: crypto.randomUUID(),
      sub: caller.sub,
      email: invite.email,
      role: invite.role,
      addedAt: now.toISOString(),
    };
    return {
      members: { ...current, invites, members: [...current.members, member] },
      result: { status: 200, body: { tourId } },
    };
  });
  if (outcome.status === 200) await recordMembership(bucket, caller.sub, owner, tourId);
  return outcome;
};

/** The editor's index entry for a tour. Best-effort: the dashboard re-heals it on open. */
export const recordMembership = async (
  bucket: R2Bucket,
  member: string,
  owner: string,
  tourId: string,
): Promise<void> => {
  try {
    await putJson(bucket, membershipKey(member, tourId), { v: 1, owner });
  } catch (e) {
    console.error(
      `[members] membership index for tour ${tourId} not written:`,
      e instanceof Error ? e.name : 'unknown error',
    );
  }
};

// How many shared tours are summarised at once.
const SHARED_CONCURRENCY = 8;

/**
 * GET /api/admin/shared-tours: the tours the caller edits, newest change first. Each index
 * entry is re-checked against the owner's members.json; one that no longer holds (removed,
 * the tour deleted, the owner's account going) is dropped and deleted.
 */
export const listSharedTours = async (
  bucket: R2Bucket,
  caller: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<SharedTourSummary[]> => {
  const prefix = userMembershipsPrefix(caller);
  const listed = await bucket.list({ prefix, limit: MAX_MEMBERSHIPS });
  const tourIds = listed.objects
    .map((o) => o.key.slice(prefix.length, -'.json'.length))
    .filter((id) => id.length > 0);
  const out: SharedTourSummary[] = [];
  const stale: string[] = [];
  for (let i = 0; i < tourIds.length; i += SHARED_CONCURRENCY) {
    const batch = tourIds.slice(i, i + SHARED_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (tourId) => {
        const access = await tourAccessFor(bucket, caller, tourId);
        if (isRefusal(access) || access.role !== 'editor') {
          stale.push(tourId);
          return null;
        }
        const [tourObj, publishObj] = await Promise.all([
          bucket.head(tourKey(access.owner, tourId)),
          bucket.head(publishKey(access.owner, tourId)),
        ]);
        if (!tourObj) return null;
        const fields = await resolveTourFields(
          tourObj.customMetadata,
          async () => (await getJson<TourDoc>(bucket, tourObj.key))?.value ?? null,
        );
        return {
          tourId,
          ...fields,
          updatedAt: tourObj.uploaded.toISOString(),
          etag: tourObj.etag,
          publish: toPublishSummary(publishObj?.customMetadata),
          ownerEmail: access.members?.ownerEmail ?? null,
        } satisfies SharedTourSummary;
      }),
    );
    for (const r of results) if (r) out.push(r);
  }
  if (stale.length > 0) {
    waitUntil(
      Promise.allSettled(stale.map((tourId) => bucket.delete(membershipKey(caller, tourId)))),
    );
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

/**
 * For tour delete (owner or operator) and the owner's account delete: drops every editor's
 * index entry for the tour. members.json itself goes with the tour's prefix, or here when
 * the caller doesn't delete the whole prefix.
 */
export const forgetMembers = async (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
): Promise<void> => {
  const { members, etag } = await readMembers(bucket, owner, tourId);
  await Promise.all(members.members.map((m) => bucket.delete(membershipKey(m.sub, tourId))));
  if (etag !== null) await bucket.delete(membersKey(owner, tourId));
};

/**
 * For the editor's own account delete: takes them off every tour their index names, then
 * deletes the index. An entry whose tour no longer lists them is just deleted.
 */
export const leaveAllTours = async (bucket: R2Bucket, member: string): Promise<void> => {
  const prefix = userMembershipsPrefix(member);
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      const tourId = obj.key.slice(prefix.length, -'.json'.length);
      // An id that isn't a content id can't name a members.json: nothing to leave.
      if (!isContentId(tourId)) continue;
      const record = MembershipRecordSchema.safeParse(
        (await getJson<unknown>(bucket, obj.key))?.value,
      );
      if (!record.success) continue;
      await updateMembers<void>(bucket, record.data.owner, tourId, (current) =>
        current.members.some((m) => m.sub === member)
          ? {
              members: { ...current, members: current.members.filter((m) => m.sub !== member) },
              result: undefined,
            }
          : { refuse: undefined },
      );
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await deletePrefix(bucket, prefix);
};

import {
  configKey,
  isContentId,
  lentPanosKey,
  MAX_TOURS_PER_OWNER,
  membersKey,
  membershipKey,
  originalKey,
  panoPrefix,
  publishKey,
  pubTourKey,
  tourKey,
  tourOwnerKey,
  TOUR_TRANSFERS_ROOT,
  tourTransferKey,
  TourTransferRecordSchema,
  TRANSFER_OFFER_DAYS,
  uploadedForKey,
  userPanosPrefix,
  type PublishedTour,
  type SceneConfig,
  type TourAccess,
  type TourDoc,
  type TourMember,
  type TourMembers,
  type LentPanos,
  type TourOwnerRecord,
  type TourTransferOffer,
  type TourTransferRecord,
  type TransferRefused,
} from '@internal/contracts';
import { deletePrefix, getJson, putJson } from '@internal/worker-kit/r2-binding';

import { configCustomMetadata, countTours, tourCustomMetadata } from './lists.js';
import { readMembers, updateMembers } from './members.js';
import { referencedPanoIds } from './references.js';

// Changing a tour's owner (docs/decisions.md, "Tour editors"). The owner offers the tour to
// one of its editors, who accepts. Everything the tour has then moves from the old owner's
// prefixes to the new one's: tour.json and the rest of tours/<owner>/<tourId>/, and every
// pano the tour uses (its draft and its live bundle). A pano the old owner's other tours
// still use is copied under a fresh id instead and tiled again from its original; the rest
// keep their ids, so their tiles (owner-free) stay as they are. The old owner stays on as an
// editor. Runs in the tour's TourPublisher, so no publish interleaves, and every step can be
// run again: tour-transfers/<tourId>.json says a transfer is under way until it is done.

const DAY_MS = 24 * 60 * 60 * 1000;
// A write that slipped in before the transfer record (it had already passed the check) is
// caught by tour.json's ETag and copied again; after this many rounds the cron finishes it.
const TOUR_COPY_ROUNDS = 3;

const tourPrefix = (owner: string, tourId: string): string =>
  tourKey(owner, tourId).slice(0, -'tour.json'.length);

const openOffer = (members: TourMembers, nowMs: number): TourTransferOffer | null =>
  members.transfer && Date.parse(members.transfer.expiresAt) > nowMs ? members.transfer : null;

export type OfferOutcome =
  | { status: 201; body: { transfer: { memberId: string; expiresAt: string } } }
  | { status: 404; body: { error: 'member not found' } };

/** POST …/transfer, owner only: offers the tour to one of its editors. Replaces an earlier offer. */
export const offerTransfer = (
  bucket: R2Bucket,
  { sub: owner, email }: { sub: string; email: string | null },
  tourId: string,
  memberId: string,
  now: Date,
): Promise<OfferOutcome> =>
  updateMembers<OfferOutcome>(bucket, owner, tourId, (current) => {
    if (!current.members.some((m) => m.id === memberId)) {
      return { refuse: { status: 404, body: { error: 'member not found' } } };
    }
    const transfer: TourTransferOffer = {
      memberId,
      offeredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TRANSFER_OFFER_DAYS * DAY_MS).toISOString(),
    };
    // The owner's email as of now, so once they are an editor their row names them.
    return {
      members: { ...current, ownerEmail: email ?? current.ownerEmail, transfer },
      result: { status: 201, body: { transfer: { memberId, expiresAt: transfer.expiresAt } } },
    };
  });

/**
 * DELETE …/transfer: the owner withdraws the offer, or the editor it was made to turns it
 * down. Idempotent; false when the caller is an editor the offer isn't for.
 */
export const cancelTransfer = (
  bucket: R2Bucket,
  access: TourAccess,
  caller: string,
  tourId: string,
): Promise<boolean> =>
  updateMembers<boolean>(bucket, access.owner, tourId, (current) => {
    if (!current.transfer) return { refuse: true };
    if (access.role !== 'owner') {
      const offeredTo = current.members.find((m) => m.id === current.transfer?.memberId);
      if (offeredTo?.sub !== caller) return { refuse: false };
    }
    const { transfer: _offer, ...rest } = current;
    return { members: rest, result: true };
  });

/** Most panos and bytes of originals one owner may hold (upload-api's quota vars). */
export interface OwnerLimits {
  maxPanos: number | null;
  maxBytes: number | null;
}

// Same rule as upload-api's parseLimit: unset is unlimited, anything but a non-negative
// integer refuses rather than lifting the limit.
const parseLimit = (name: string, raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

export const ownerLimits = (env: {
  MAX_PANOS_PER_OWNER?: string;
  MAX_BYTES_PER_OWNER?: string;
}): OwnerLimits => ({
  maxPanos: parseLimit('MAX_PANOS_PER_OWNER', env.MAX_PANOS_PER_OWNER),
  maxBytes: parseLimit('MAX_BYTES_PER_OWNER', env.MAX_BYTES_PER_OWNER),
});

/** Panos `sub` holds (not on their way out) and their originals' bytes, as upload-api counts. */
const holdings = async (
  bucket: R2Bucket,
  sub: string,
): Promise<{ panos: number; bytes: number }> => {
  const prefix = userPanosPrefix(sub);
  const ids = new Set<string>();
  const deleting = new Set<string>();
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      const [panoId, name] = obj.key.slice(prefix.length).split('/');
      if (!panoId) continue;
      ids.add(panoId);
      if (name === 'deleting') deleting.add(panoId);
      if (name === 'original') bytes += obj.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { panos: ids.size - deleting.size, bytes };
};

/** Every pano the tour uses: its draft's scenes and, while it is published, its live bundle's. */
const tourPanoIds = async (
  bucket: R2Bucket,
  owner: string,
  tourId: string,
  tour: TourDoc,
): Promise<string[]> => {
  const ids = new Set(tour.scenes.map((s) => s.panoId));
  if (await bucket.head(publishKey(owner, tourId))) {
    const bundle = await getJson<Partial<PublishedTour>>(bucket, pubTourKey(tourId));
    for (const scene of bundle?.value.scenes ?? []) {
      if (typeof scene?.panoId === 'string') ids.add(scene.panoId);
    }
  }
  return [...ids];
};

export type StartOutcome =
  { status: 200; body: { tourId: string } } | { status: 403 | 404 | 410; body: TransferRefused };

const refused = (status: 403 | 404 | 410, error: TransferRefused['error']): StartOutcome => ({
  status,
  body: { error },
});

/**
 * The editor `to` takes the tour over from `from`, once the open offer names them and the
 * tour fits their limits. Writes the transfer record, then runs it. Only from the tour's
 * TourPublisher queue.
 */
export const startTransfer = async (
  bucket: R2Bucket,
  { from, to, toEmail }: { from: string; to: string; toEmail: string | null },
  tourId: string,
  limits: OwnerLimits,
  now: Date,
): Promise<StartOutcome> => {
  // Accepted twice (a retry, a double click): finish the one under way.
  const existing = await readTransfer(bucket, tourId);
  if (existing) {
    if (existing.to !== to) return refused(404, 'no offer');
    await runTransfer(bucket, tourId, existing, now);
    return { status: 200, body: { tourId } };
  }
  const [{ members }, tourObj] = await Promise.all([
    readMembers(bucket, from, tourId),
    getJson<TourDoc>(bucket, tourKey(from, tourId)),
  ]);
  if (!tourObj) return refused(404, 'no offer');
  const offeredTo = members.members.find((m) => m.id === members.transfer?.memberId);
  if (!members.transfer || offeredTo?.sub !== to) return refused(404, 'no offer');
  if (!openOffer(members, now.getTime())) return refused(410, 'offer expired');

  // Which panos move and which are copied, fixed now so a resumed run makes the same copies.
  const ids = await tourPanoIds(bucket, from, tourId, tourObj.value);
  const elsewhere = await referencedPanoIds(bucket, from, tourId);
  const heads = await Promise.all(ids.map((id) => bucket.head(originalKey(from, id))));
  const panos: Record<string, string> = {};
  let incomingBytes = 0;
  ids.forEach((id, i) => {
    const original = heads[i];
    // A scene whose pano is gone has nothing to move; the tour keeps naming it, as before.
    if (!original) return;
    panos[id] = elsewhere.has(id) ? crypto.randomUUID() : id;
    incomingBytes += original.size;
  });

  // The new owner's limits, counting what arrives. Soft, like upload-api's.
  if ((await countTours(bucket, to, MAX_TOURS_PER_OWNER)) >= MAX_TOURS_PER_OWNER) {
    return refused(403, 'tour limit reached');
  }
  if (limits.maxPanos !== null || limits.maxBytes !== null) {
    const held = await holdings(bucket, to);
    const incoming = Object.keys(panos).length;
    if (limits.maxPanos !== null && held.panos + incoming > limits.maxPanos) {
      return refused(403, 'pano limit reached');
    }
    if (limits.maxBytes !== null && held.bytes + incomingBytes > limits.maxBytes) {
      return refused(403, 'storage limit reached');
    }
  }

  const record: TourTransferRecord = {
    v: 1,
    from,
    to,
    fromEmail: members.ownerEmail,
    toEmail: toEmail ?? offeredTo.email,
    startedAt: now.toISOString(),
    panos,
  };
  // Before the record: from then on these count as in use for the old owner
  // (references.ts), so no delete of theirs takes one while it moves, nor after while the
  // live bundle still names it.
  const lent: LentPanos = { v: 1, panoIds: Object.keys(panos) };
  await putJson(bucket, lentPanosKey(from, tourId), lent);
  // Create-only: from here on every write to the tour is refused (members.ts).
  const created = await putJson(bucket, tourTransferKey(tourId), record, {
    etagDoesNotMatch: '*',
  });
  const current = created.ok ? record : await readTransfer(bucket, tourId);
  if (!current || current.to !== to) return refused(404, 'no offer');
  await runTransfer(bucket, tourId, current, now);
  return { status: 200, body: { tourId } };
};

export const readTransfer = async (
  bucket: R2Bucket,
  tourId: string,
): Promise<TourTransferRecord | null> => {
  const got = await getJson<unknown>(bucket, tourTransferKey(tourId));
  const parsed = TourTransferRecordSchema.safeParse(got?.value);
  return parsed.success ? parsed.data : null;
};

/** Copies one object, body streamed, with both kinds of metadata. False if it wasn't there. */
const copyObject = async (bucket: R2Bucket, from: string, to: string): Promise<boolean> => {
  const obj = await bucket.get(from);
  if (!obj) return false;
  const copy = await bucket.put(to, obj.body, {
    httpMetadata: obj.httpMetadata ?? {},
    customMetadata: obj.customMetadata ?? {},
  });
  if (copy.size !== obj.size) {
    await bucket.delete(copy.key);
    throw new Error('copy is incomplete');
  }
  return true;
};

const listKeys = async (bucket: R2Bucket, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
};

const remapConfig = (
  config: SceneConfig,
  panoId: string,
  panos: Record<string, string>,
): SceneConfig => ({
  ...config,
  panoId,
  hotspots: config.hotspots.map((h) =>
    h.targetPanoId && panos[h.targetPanoId] ? { ...h, targetPanoId: panos[h.targetPanoId] } : h,
  ),
});

/**
 * One pano into the new owner's account. A move copies everything under its prefix (the
 * original first, which the tiler sees as the same bytes it already tiled) and its
 * uploaded-for record; a copy takes the original and the config under its new id, and the
 * original's arrival tiles it. Either way the config's links follow the map.
 */
const copyPano = async (
  bucket: R2Bucket,
  rec: TourTransferRecord,
  oldId: string,
  newId: string,
): Promise<void> => {
  const moving = oldId === newId;
  if (moving) {
    const from = panoPrefix(rec.from, oldId);
    const keys = (await listKeys(bucket, from)).filter((k) => k !== configKey(rec.from, oldId));
    for (const key of keys) {
      const to = `${panoPrefix(rec.to, newId)}${key.slice(from.length)}`;
      // A resumed run needn't stream a large original again.
      const [src, dst] = await Promise.all([bucket.head(key), bucket.head(to)]);
      if (src && dst?.etag === src.etag) continue;
      await copyObject(bucket, key, to);
    }
    await copyObject(bucket, uploadedForKey(rec.from, oldId), uploadedForKey(rec.to, newId));
  } else if (!(await bucket.head(originalKey(rec.to, newId)))) {
    await copyObject(bucket, originalKey(rec.from, oldId), originalKey(rec.to, newId));
  }
  const config = await getJson<SceneConfig>(bucket, configKey(rec.from, oldId));
  if (config) {
    const next = remapConfig(config.value, newId, rec.panos);
    await putJson(bucket, configKey(rec.to, newId), next, undefined, configCustomMetadata(next));
  }
};

/** Moving panos the old owner's other tours use now (they weren't when the map was made). */
const reclaimed = async (
  bucket: R2Bucket,
  tourId: string,
  rec: TourTransferRecord,
): Promise<string[]> => {
  const moving = Object.entries(rec.panos).filter(([o, n]) => o === n);
  if (moving.length === 0) return [];
  const inUse = await referencedPanoIds(bucket, rec.from, tourId);
  return moving.map(([id]) => id).filter((id) => inUse.has(id));
};

/** Turns moves into copies: a fresh id each, the record rewritten, the moved keys dropped. */
const asCopies = async (
  bucket: R2Bucket,
  tourId: string,
  rec: TourTransferRecord,
  ids: readonly string[],
): Promise<TourTransferRecord> => {
  const panos = { ...rec.panos };
  for (const id of ids) panos[id] = crypto.randomUUID();
  const next = { ...rec, panos };
  await putJson(bucket, tourTransferKey(tourId), next);
  for (const id of ids) {
    // Only the new owner's prefix: tiles/<id>/ are the old owner's again.
    await deletePrefix(bucket, panoPrefix(rec.to, id));
    await bucket.delete(uploadedForKey(rec.to, id));
  }
  return next;
};

const remapTour = (tour: TourDoc, panos: Record<string, string>): TourDoc => ({
  ...tour,
  scenes: tour.scenes.map((s) => ({ ...s, panoId: panos[s.panoId] ?? s.panoId })),
  ...(tour.startPanoId !== undefined && {
    startPanoId: panos[tour.startPanoId] ?? tour.startPanoId,
  }),
});

// The new owner's members.json: the same editors and invites, less the new owner, plus the
// old owner as an editor. The offer is spent.
const handOver = (members: TourMembers, rec: TourTransferRecord, now: Date): TourMembers => {
  const { transfer: _offer, ...rest } = members;
  const oldOwner: TourMember = {
    id: crypto.randomUUID(),
    sub: rec.from,
    email: rec.fromEmail ?? '',
    role: 'editor',
    addedAt: now.toISOString(),
  };
  return {
    ...rest,
    ownerEmail: rec.toEmail,
    members: [...members.members.filter((m) => m.sub !== rec.to && m.sub !== rec.from), oldOwner],
  };
};

/**
 * Runs (or finishes) a transfer. Every step can be repeated: copies land on the same keys,
 * and the old owner's copies are deleted only after the new owner's tour.json, members.json
 * and the owner pointer are written. A tour deleted under way just drops the record.
 */
export const runTransfer = async (
  bucket: R2Bucket,
  tourId: string,
  started: TourTransferRecord,
  now: Date = new Date(),
): Promise<void> => {
  let rec = started;
  const oldPrefix = tourPrefix(rec.from, tourId);
  const newPrefix = tourPrefix(rec.to, tourId);
  for (let round = 1; ;) {
    const tourObj = await bucket.get(tourKey(rec.from, tourId));
    if (!tourObj) break;
    const tour = await tourObj.json<TourDoc>();
    for (const [oldId, newId] of Object.entries(rec.panos)) {
      await copyPano(bucket, rec, oldId, newId);
    }
    // The rest of the tour's prefix as is (publish.json, sharing-stopped.json, ...);
    // tour.json and members.json are written for the new owner below.
    const own = new Set([tourKey(rec.from, tourId), membersKey(rec.from, tourId)]);
    for (const key of await listKeys(bucket, oldPrefix)) {
      if (!own.has(key))
        await copyObject(bucket, key, `${newPrefix}${key.slice(oldPrefix.length)}`);
    }
    // Create-only: a resumed run, after the old one is gone, must not write an empty list.
    // members.json doesn't change under way (every members write is refused).
    const { members } = await readMembers(bucket, rec.from, tourId);
    await putJson(bucket, membersKey(rec.to, tourId), handOver(members, rec, now), {
      etagDoesNotMatch: '*',
    });
    const next = remapTour(tour, rec.panos);
    await putJson(bucket, tourKey(rec.to, tourId), next, undefined, tourCustomMetadata(next));
    const pointer: TourOwnerRecord = { v: 1, sub: rec.to };
    await putJson(bucket, tourOwnerKey(tourId), pointer);
    // A save that passed its check just before the record was written: copy again.
    const after = await bucket.head(tourKey(rec.from, tourId));
    if (after?.etag !== tourObj.etag) {
      if (round >= TOUR_COPY_ROUNDS) throw new Error('tour.json kept changing during its transfer');
      round += 1;
      continue;
    }
    // A moving pano the old owner has since put in another tour stays theirs: it becomes a
    // copy, and this round runs again with the new map.
    const taken = await reclaimed(bucket, tourId, rec);
    if (taken.length > 0) {
      rec = await asCopies(bucket, tourId, rec, taken);
      continue;
    }
    // tour.json last: while it is there a resumed run copies everything again.
    const rest = (await listKeys(bucket, oldPrefix)).filter((k) => !own.has(k));
    await Promise.all([...rest, membersKey(rec.from, tourId)].map((k) => bucket.delete(k)));
    await bucket.delete(tourKey(rec.from, tourId));
    break;
  }

  if (!(await bucket.head(tourKey(rec.to, tourId)))) {
    // Neither owner holds the tour: it was deleted under way.
    await bucket.delete(tourTransferKey(tourId));
    return;
  }
  // Each editor's dashboard index names the owner; the new owner's own entry goes.
  const { members } = await readMembers(bucket, rec.to, tourId);
  await Promise.all([
    ...members.members.map((m) =>
      putJson(bucket, membershipKey(m.sub, tourId), { v: 1, owner: rec.to }),
    ),
    bucket.delete(membershipKey(rec.to, tourId)),
  ]);
  // The panos that moved leave the old owner's account; copies stay theirs. Checked once
  // more: one put in another tour since the check above stays (in both accounts, until
  // either deletes it) rather than vanish from that tour.
  const inUse = await referencedPanoIds(bucket, rec.from, tourId);
  for (const [oldId, newId] of Object.entries(rec.panos)) {
    if (oldId !== newId || inUse.has(oldId)) continue;
    await deletePrefix(bucket, panoPrefix(rec.from, oldId));
    await bucket.delete(uploadedForKey(rec.from, oldId));
  }
  await bucket.delete(tourTransferKey(tourId));
};

/** The daily sweep: finishes any transfer an interrupted request left. */
export const transfersToFinish = async (bucket: R2Bucket): Promise<string[]> =>
  (await listKeys(bucket, TOUR_TRANSFERS_ROOT))
    .map((k) => k.slice(TOUR_TRANSFERS_ROOT.length, -'.json'.length))
    .filter(isContentId);

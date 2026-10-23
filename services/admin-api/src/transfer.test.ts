import {
  configKey,
  lentPanosKey,
  manifestKey,
  membersKey,
  membershipKey,
  originalKey,
  PANO_DELETE_CONFLICTS,
  publishKey,
  tourKey,
  tourOwnerKey,
  tourTransferKey,
  uploadedForKey,
  type InviteCreateOk,
  type MembersOk,
  type SceneConfig,
  type TourDoc,
  type TourMembers,
  type TourOk,
  type TourTransferRecord,
} from '@internal/contracts';
import { parseJsonc, setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import uploadWrangler from '../../upload-api/wrangler.jsonc?raw';
import wrangler from '../wrangler.jsonc?raw';
import { dropSpentLoans, referencedPanoIds } from './references.js';

// Storage is shared across it() cases in this file, so every case uses its own people,
// panos and tours.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    const now = Math.floor(Date.now() / 1000);
    // `good:<who>`: signed in just now with a verified <who>@example.com.
    if (t.startsWith('good:')) {
      const who = t.slice(5);
      return { sub: `auth0|${who}`, email: `${who}@example.com`, authTime: now };
    }
    // `stale:<who>`: the same, signed in an hour ago.
    if (t.startsWith('stale:')) {
      const who = t.slice(6);
      return { sub: `auth0|${who}`, email: `${who}@example.com`, authTime: now - 3600 };
    }
    throw new Error('bad');
  });
});

const subOf = (who: string) => `auth0|${who}`;
const emailOf = (who: string) => `${who}@example.com`;

const api = (who: string, method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x/api/admin${path}`, {
    method,
    headers: {
      Authorization: who.includes(':') ? `Bearer ${who}` : `Bearer good:${who}`,
      ...(method === 'PUT' ? { 'If-Match': '*' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const stored = async <T>(key: string): Promise<T | null> =>
  ((await env.BUCKET.get(key))?.json<T>() as Promise<T> | undefined) ?? null;

/** A tiled pano under `who`'s prefix, configured; `links` become link hotspots. */
const readyPano = async (who: string, panoId: string, links: string[] = []) => {
  await env.BUCKET.put(originalKey(subOf(who), panoId), 'bytes');
  const config = {
    title: panoId,
    hotspots: links.map((target, i) => ({
      id: `h${i}`,
      type: 'link',
      yaw: 0,
      pitch: 0,
      title: 'Go',
      targetPanoId: target,
    })),
  };
  expect((await api(who, 'PUT', `/panos/${panoId}/config`, config)).status).toBe(200);
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId, version: 't1-a' }));
};

const newTour = async (who: string, panoIds: string[]) => {
  const r = await api(who, 'POST', '/tours', {
    title: `Tour of ${who}`,
    scenes: panoIds.map((panoId) => ({ panoId })),
    startPanoId: panoIds[0],
  });
  expect(r.status).toBe(201);
  return (await json<{ tourId: string }>(r)).tourId;
};

/** `owner`'s tour with `editor` added through a real invite; returns the editor's member id. */
const share = async (owner: string, editor: string, tourId: string) => {
  const r = await api(owner, 'POST', `/tours/${tourId}/invites`, { email: emailOf(editor) });
  const { token } = await json<InviteCreateOk>(r);
  expect((await api(editor, 'POST', '/invites/accept', { token })).status).toBe(200);
  const members = await json<MembersOk>(await api(owner, 'GET', `/tours/${tourId}/members`));
  return members.members.find((m) => m.email === emailOf(editor))!.id;
};

const offer = (owner: string, tourId: string, memberId: string) =>
  api(owner, 'POST', `/tours/${tourId}/transfer`, { memberId });
const take = (who: string, tourId: string) => api(who, 'POST', `/tours/${tourId}/transfer/accept`);

describe('changing a tour’s owner', () => {
  it('moves the tour and its own panos to the editor, and keeps the old owner as an editor', async () => {
    await readyPano('tr-a', 'tr-a-p1', ['tr-a-p2']);
    await readyPano('tr-a', 'tr-a-p2');
    const tourId = await newTour('tr-a', ['tr-a-p1', 'tr-a-p2']);
    await env.BUCKET.put(
      uploadedForKey(subOf('tr-a'), 'tr-a-p2'),
      JSON.stringify({ v: 1, tourId, sub: subOf('tr-b') }),
    );
    expect((await api('tr-a', 'POST', `/tours/${tourId}/publish`, {})).status).toBe(200);
    const memberId = await share('tr-a', 'tr-b', tourId);
    await share('tr-a', 'tr-c', tourId);

    const offered = await offer('tr-a', tourId, memberId);
    expect(offered.status).toBe(201);
    const seen = await json<MembersOk>(await api('tr-b', 'GET', `/tours/${tourId}/members`));
    expect(seen.transfer?.memberId).toBe(memberId);

    const r = await take('tr-b', tourId);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ tourId });

    // The new owner holds it all; the old owner's prefix has none of it.
    const mine = await json<TourOk>(await api('tr-b', 'GET', `/tours/${tourId}`));
    expect(mine.role).toBe('owner');
    expect(mine.tour.scenes.map((s) => s.panoId)).toEqual(['tr-a-p1', 'tr-a-p2']);
    expect(mine.publish).not.toBeNull();
    for (const key of [tourKey, membersKey, publishKey]) {
      expect(await env.BUCKET.head(key(subOf('tr-a'), tourId))).toBeNull();
    }
    expect(await env.BUCKET.head(publishKey(subOf('tr-b'), tourId))).not.toBeNull();
    // Its panos moved under the same ids: their tiles, which are owner-free, still serve.
    for (const panoId of ['tr-a-p1', 'tr-a-p2']) {
      expect(await env.BUCKET.head(originalKey(subOf('tr-b'), panoId))).not.toBeNull();
      expect(await env.BUCKET.head(originalKey(subOf('tr-a'), panoId))).toBeNull();
      expect(await env.BUCKET.head(manifestKey(panoId))).not.toBeNull();
    }
    expect(await env.BUCKET.head(uploadedForKey(subOf('tr-a'), 'tr-a-p2'))).toBeNull();
    expect(await env.BUCKET.head(uploadedForKey(subOf('tr-b'), 'tr-a-p2'))).not.toBeNull();
    expect(await stored(tourOwnerKey(tourId))).toEqual({ v: 1, sub: subOf('tr-b') });

    // The old owner is an editor now; the other editor stays one, under the new owner.
    const theirs = await json<TourOk>(await api('tr-a', 'GET', `/tours/${tourId}`));
    expect(theirs.role).toBe('editor');
    const members = await stored<TourMembers>(membersKey(subOf('tr-b'), tourId));
    expect(members?.ownerEmail).toBe(emailOf('tr-b'));
    expect(members?.transfer).toBeUndefined();
    expect(members?.members.map((m) => m.sub).sort()).toEqual([subOf('tr-a'), subOf('tr-c')]);
    expect(await stored(membershipKey(subOf('tr-a'), tourId))).toEqual({
      v: 1,
      owner: subOf('tr-b'),
    });
    expect(await stored(membershipKey(subOf('tr-c'), tourId))).toEqual({
      v: 1,
      owner: subOf('tr-b'),
    });
    expect(await env.BUCKET.head(membershipKey(subOf('tr-b'), tourId))).toBeNull();
    expect(await env.BUCKET.head(tourTransferKey(tourId))).toBeNull();

    // Accepting again is the same answer.
    expect((await take('tr-b', tourId)).status).toBe(200);
  });

  it('copies a pano the old owner’s other tours still use, under a new id', async () => {
    await readyPano('tr-d', 'tr-d-shared', ['tr-d-own']);
    await readyPano('tr-d', 'tr-d-own', ['tr-d-shared']);
    const tourId = await newTour('tr-d', ['tr-d-shared', 'tr-d-own']);
    await newTour('tr-d', ['tr-d-shared']);
    const memberId = await share('tr-d', 'tr-e', tourId);
    expect((await offer('tr-d', tourId, memberId)).status).toBe(201);
    expect((await take('tr-e', tourId)).status).toBe(200);

    const tour = (await stored<TourDoc>(tourKey(subOf('tr-e'), tourId)))!;
    const copyId = tour.scenes[0]!.panoId;
    expect(copyId).not.toBe('tr-d-shared');
    expect(tour.startPanoId).toBe(copyId);
    expect(tour.scenes[1]!.panoId).toBe('tr-d-own');
    // The old owner keeps theirs; the new owner's copy is tiled from its own original.
    expect(await env.BUCKET.head(originalKey(subOf('tr-d'), 'tr-d-shared'))).not.toBeNull();
    expect(await env.BUCKET.head(originalKey(subOf('tr-e'), copyId))).not.toBeNull();
    const copy = await stored<SceneConfig>(configKey(subOf('tr-e'), copyId));
    expect(copy?.panoId).toBe(copyId);
    // Links follow the panos to their new ids.
    expect(copy?.hotspots[0]?.targetPanoId).toBe('tr-d-own');
    const own = await stored<SceneConfig>(configKey(subOf('tr-e'), 'tr-d-own'));
    expect(own?.hotspots[0]?.targetPanoId).toBe(copyId);
  });

  it('wants a recent sign-in to offer, and only the owner may offer', async () => {
    await readyPano('tr-f', 'tr-f-p1');
    const tourId = await newTour('tr-f', ['tr-f-p1']);
    const memberId = await share('tr-f', 'tr-g', tourId);
    const stale = await offer('stale:tr-f', tourId, memberId);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauthentication required' });
    expect((await offer('tr-g', tourId, memberId)).status).toBe(403);
    expect((await offer('tr-f', tourId, 'nobody')).status).toBe(404);
  });

  it('is only for the editor the offer names, until it expires or is turned down', async () => {
    await readyPano('tr-h', 'tr-h-p1');
    const tourId = await newTour('tr-h', ['tr-h-p1']);
    const memberId = await share('tr-h', 'tr-i', tourId);
    await share('tr-h', 'tr-j', tourId);
    expect(await (await take('tr-i', tourId)).json()).toEqual({ error: 'no offer' });

    expect((await offer('tr-h', tourId, memberId)).status).toBe(201);
    expect((await take('tr-j', tourId)).status).toBe(404);
    // Another editor can't turn it down for them.
    expect((await api('tr-j', 'DELETE', `/tours/${tourId}/transfer`)).status).toBe(403);
    expect((await api('tr-i', 'DELETE', `/tours/${tourId}/transfer`)).status).toBe(204);
    expect((await take('tr-i', tourId)).status).toBe(404);

    // An expired offer.
    expect((await offer('tr-h', tourId, memberId)).status).toBe(201);
    const key = membersKey(subOf('tr-h'), tourId);
    const members = (await stored<TourMembers>(key))!;
    await env.BUCKET.put(
      key,
      JSON.stringify({
        ...members,
        transfer: { ...members.transfer, expiresAt: '2020-01-01T00:00:00Z' },
      }),
    );
    expect(await (await take('tr-i', tourId)).json()).toEqual({ error: 'offer expired' });

    // Removing the editor withdraws the offer made to them.
    expect((await offer('tr-h', tourId, memberId)).status).toBe(201);
    expect((await api('tr-h', 'DELETE', `/tours/${tourId}/members/${memberId}`)).status).toBe(204);
    expect((await stored<TourMembers>(key))?.transfer).toBeUndefined();
  });

  it('counts the tour against the new owner’s pano limit', async () => {
    await readyPano('tr-k', 'tr-k-p1');
    const tourId = await newTour('tr-k', ['tr-k-p1']);
    const memberId = await share('tr-k', 'tr-l', tourId);
    // wrangler.jsonc's dev env holds 500 panos an owner.
    await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        env.BUCKET.put(originalKey(subOf('tr-l'), `tr-l-${i}`), 'x'),
      ),
    );
    expect((await offer('tr-k', tourId, memberId)).status).toBe(201);
    const r = await take('tr-l', tourId);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'pano limit reached' });
    expect(await env.BUCKET.head(tourKey(subOf('tr-k'), tourId))).not.toBeNull();
  });

  it('refuses writes while under way, and the new owner’s retry finishes it', async () => {
    await readyPano('tr-m', 'tr-m-p1');
    const tourId = await newTour('tr-m', ['tr-m-p1']);
    await share('tr-m', 'tr-n', tourId);
    // As an interrupted run leaves it: the record written, nothing moved yet.
    const record: TourTransferRecord = {
      v: 1,
      from: subOf('tr-m'),
      to: subOf('tr-n'),
      fromEmail: emailOf('tr-m'),
      toEmail: emailOf('tr-n'),
      startedAt: new Date().toISOString(),
      panos: { 'tr-m-p1': 'tr-m-p1' },
    };
    await env.BUCKET.put(tourTransferKey(tourId), JSON.stringify(record));
    const tour = { tourId, title: 'Changed', scenes: [{ panoId: 'tr-m-p1' }] };
    expect((await api('tr-m', 'PUT', `/tours/${tourId}`, tour)).status).toBe(409);
    expect((await api('tr-n', 'PUT', `/tours/${tourId}`, tour)).status).toBe(409);
    expect((await api('tr-m', 'DELETE', `/tours/${tourId}`)).status).toBe(409);
    const invite = await api('tr-m', 'POST', `/tours/${tourId}/invites`, {
      email: 'x@example.com',
    });
    expect(invite.status).toBe(409);
    // Nor the publish-state routes, which go straight to the TourPublisher.
    expect((await api('tr-m', 'PUT', `/tours/${tourId}/slug`, { slug: 'tr-m-x' })).status).toBe(
      409,
    );
    const visibility = await api('tr-m', 'PATCH', `/tours/${tourId}/visibility`, {
      visibility: 'unlisted',
    });
    expect(visibility.status).toBe(409);
    expect((await api('tr-m', 'DELETE', `/tours/${tourId}/publish`)).status).toBe(409);
    // Someone else can't finish it.
    expect((await take('tr-m', tourId)).status).toBe(409);

    expect((await take('tr-n', tourId)).status).toBe(200);
    expect(await env.BUCKET.head(tourKey(subOf('tr-n'), tourId))).not.toBeNull();
    expect(await env.BUCKET.head(tourKey(subOf('tr-m'), tourId))).toBeNull();
    expect(await env.BUCKET.head(originalKey(subOf('tr-n'), 'tr-m-p1'))).not.toBeNull();
    expect(await env.BUCKET.head(tourTransferKey(tourId))).toBeNull();
    expect((await api('tr-n', 'PUT', `/tours/${tourId}`, tour)).status).toBe(200);
  });
});

describe('panos the old owner still holds', () => {
  it('stay while the handed-on tour’s live bundle uses them', async () => {
    await readyPano('tr-o', 'tr-o-shared');
    const tourId = await newTour('tr-o', ['tr-o-shared']);
    const otherId = await newTour('tr-o', ['tr-o-shared']);
    expect((await api('tr-o', 'POST', `/tours/${tourId}/publish`, {})).status).toBe(200);
    const memberId = await share('tr-o', 'tr-p', tourId);
    expect((await offer('tr-o', tourId, memberId)).status).toBe(201);
    expect((await take('tr-p', tourId)).status).toBe(200);
    const copyId = (await stored<TourDoc>(tourKey(subOf('tr-p'), tourId)))!.scenes[0]!.panoId;
    expect(copyId).not.toBe('tr-o-shared');

    // The live bundle still serves the old id until the new owner publishes, so neither
    // deleting the old owner's other tour nor the pano itself takes its tiles.
    expect((await api('tr-o', 'DELETE', `/tours/${otherId}`)).status).toBe(204);
    const refused = await api('tr-o', 'DELETE', '/panos/tr-o-shared');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: PANO_DELETE_CONFLICTS['in-use'] });
    expect(await env.BUCKET.head(manifestKey('tr-o-shared'))).not.toBeNull();
    expect(await env.BUCKET.head(originalKey(subOf('tr-o'), 'tr-o-shared'))).not.toBeNull();

    // Once the copy is tiled and published, the loan is spent.
    await env.BUCKET.put(manifestKey(copyId), JSON.stringify({ pano: copyId, version: 't1-a' }));
    expect((await api('tr-p', 'POST', `/tours/${tourId}/publish`, {})).status).toBe(200);
    await dropSpentLoans(env.BUCKET);
    expect(await env.BUCKET.head(lentPanosKey(subOf('tr-o'), tourId))).toBeNull();
    expect(await referencedPanoIds(env.BUCKET, subOf('tr-o'))).not.toContain('tr-o-shared');
  });

  it('a pano put in another tour while it was moving is copied instead', async () => {
    await readyPano('tr-q', 'tr-q-p1');
    const tourId = await newTour('tr-q', ['tr-q-p1']);
    await share('tr-q', 'tr-r', tourId);
    // An interrupted run that planned to move it; the old owner then used it elsewhere.
    const record: TourTransferRecord = {
      v: 1,
      from: subOf('tr-q'),
      to: subOf('tr-r'),
      fromEmail: null,
      toEmail: emailOf('tr-r'),
      startedAt: new Date().toISOString(),
      panos: { 'tr-q-p1': 'tr-q-p1' },
    };
    await env.BUCKET.put(tourTransferKey(tourId), JSON.stringify(record));
    await newTour('tr-q', ['tr-q-p1']);

    expect((await take('tr-r', tourId)).status).toBe(200);
    const copyId = (await stored<TourDoc>(tourKey(subOf('tr-r'), tourId)))!.scenes[0]!.panoId;
    expect(copyId).not.toBe('tr-q-p1');
    expect(await env.BUCKET.head(originalKey(subOf('tr-q'), 'tr-q-p1'))).not.toBeNull();
    expect(await env.BUCKET.head(originalKey(subOf('tr-r'), copyId))).not.toBeNull();
    expect(await env.BUCKET.head(originalKey(subOf('tr-r'), 'tr-q-p1'))).toBeNull();
    expect(await env.BUCKET.head(tourTransferKey(tourId))).toBeNull();
  });

  it('the old owner joins under the email they had when they offered', async () => {
    await readyPano('tr-s', 'tr-s-p1');
    const tourId = await newTour('tr-s', ['tr-s-p1']);
    const memberId = await share('tr-s', 'tr-t', tourId);
    const key = membersKey(subOf('tr-s'), tourId);
    const members = (await stored<TourMembers>(key))!;
    await env.BUCKET.put(key, JSON.stringify({ ...members, ownerEmail: null }));
    expect((await offer('tr-s', tourId, memberId)).status).toBe(201);
    expect((await take('tr-t', tourId)).status).toBe(200);
    const after = await stored<TourMembers>(membersKey(subOf('tr-t'), tourId));
    expect(after?.members.find((m) => m.sub === subOf('tr-s'))?.email).toBe(emailOf('tr-s'));
  });
});

describe('the new owner’s limits', () => {
  it('match upload-api’s in every env', () => {
    type Config = { env: Record<string, { vars?: Record<string, string> }> };
    const limits = (text: string) =>
      Object.fromEntries(
        Object.entries((parseJsonc(text) as Config).env).map(([name, e]) => [
          name,
          [e.vars?.MAX_PANOS_PER_OWNER, e.vars?.MAX_BYTES_PER_OWNER],
        ]),
      );
    const admin = limits(wrangler);
    expect(Object.keys(admin).sort()).toEqual(['dev', 'production']);
    expect(admin).toEqual(limits(uploadWrangler));
  });
});

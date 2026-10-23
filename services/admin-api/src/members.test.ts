import {
  ACCOUNT_DELETE_CONFIRMATION,
  accountDeletionKey,
  accountDisabledKey,
  configKey,
  INVITE_DAYS,
  manifestKey,
  MAX_TOUR_MEMBERS,
  membersKey,
  membershipKey,
  originalKey,
  publishKey,
  tourKey,
  tourOwnerKey,
  uploadedForKey,
  type InviteCreateOk,
  type MembersOk,
  type SharedToursOk,
  type TourMembers,
  type TourOk,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Storage is shared across it() cases in this file, so every case uses its own people,
// panos and tours.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    const now = Math.floor(Date.now() / 1000);
    // `good:<who>`: signed in with a verified <who>@example.com.
    if (t.startsWith('good:')) {
      const who = t.slice(5);
      return { sub: `auth0|${who}`, email: `${who}@example.com`, authTime: now };
    }
    // `noemail:<who>`: a sign-in with no trusted email (Facebook-only, say).
    if (t.startsWith('noemail:')) return { sub: `auth0|${t.slice(8)}`, authTime: now };
    throw new Error('bad');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const subOf = (who: string) => `auth0|${who}`;
const emailOf = (who: string) => `${who}@example.com`;

const api = (who: string, method: string, path: string, body?: unknown, extra = {}) =>
  SELF.fetch(`https://x/api/admin${path}`, {
    method,
    headers: {
      Authorization: who.includes(':') ? `Bearer ${who}` : `Bearer good:${who}`,
      ...(method === 'PUT' ? { 'If-Match': '*' } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

/** A tiled pano under `who`'s prefix, configured and ready to publish. */
const readyPano = async (who: string, panoId: string) => {
  await env.BUCKET.put(originalKey(subOf(who), panoId), 'bytes');
  expect(
    (await api(who, 'PUT', `/panos/${panoId}/config`, { title: panoId, hotspots: [] })).status,
  ).toBe(200);
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId, version: 't1-a' }));
};

/** `owner`'s one-scene tour; returns its id. */
const tourOf = async (owner: string) => {
  const panoId = `${owner}-p1`;
  await readyPano(owner, panoId);
  const r = await api(owner, 'POST', '/tours', { title: `Tour of ${owner}`, scenes: [{ panoId }] });
  expect(r.status).toBe(201);
  return { tourId: (await json<{ tourId: string }>(r)).tourId, panoId };
};

const invite = async (owner: string, tourId: string, email: string) => {
  const r = await api(owner, 'POST', `/tours/${tourId}/invites`, { email });
  expect(r.status).toBe(201);
  return json<InviteCreateOk>(r);
};

const accept = (who: string, token: string) => api(who, 'POST', '/invites/accept', { token });

/** `owner`'s tour with `editor` added through a real invite. */
const sharedTour = async (owner: string, editor: string) => {
  const t = await tourOf(owner);
  const { token } = await invite(owner, t.tourId, emailOf(editor));
  expect((await accept(editor, token)).status).toBe(200);
  return t;
};

/** What upload-api leaves for an editor's new pano: the original and whose upload it is. */
const editorUpload = async (owner: string, editor: string, tourId: string, panoId: string) => {
  await env.BUCKET.put(originalKey(subOf(owner), panoId), 'bytes');
  await env.BUCKET.put(
    uploadedForKey(subOf(owner), panoId),
    JSON.stringify({ v: 1, tourId, sub: subOf(editor) }),
  );
};

const membersFile = async (owner: string, tourId: string) => {
  const obj = await env.BUCKET.get(membersKey(subOf(owner), tourId));
  return obj ? ((await obj.json()) as TourMembers) : null;
};

describe('invites', () => {
  it('lets the invited person in, once, and records them on both sides', async () => {
    const { tourId } = await tourOf('inv-owner');
    const { invite: sent, token } = await invite('inv-owner', tourId, 'INV-ED@example.com ');
    expect(sent).toMatchObject({ email: 'inv-ed@example.com', role: 'editor' });
    expect(token.startsWith(`${tourId}.`)).toBe(true);
    // Only the hash is stored.
    const stored = await membersFile('inv-owner', tourId);
    expect(JSON.stringify(stored)).not.toContain(token.split('.')[1]);
    expect(stored?.ownerEmail).toBe(emailOf('inv-owner'));
    expect(await env.BUCKET.head(tourOwnerKey(tourId))).not.toBeNull();

    const r = await accept('inv-ed', token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ tourId });
    const after = await membersFile('inv-owner', tourId);
    expect(after?.invites).toEqual([]);
    expect(after?.members).toMatchObject([{ sub: subOf('inv-ed'), email: 'inv-ed@example.com' }]);
    expect(await env.BUCKET.head(membershipKey(subOf('inv-ed'), tourId))).not.toBeNull();

    // A second click on the same link is the same answer, and adds nobody.
    expect((await accept('inv-ed', token)).status).toBe(200);
    expect((await membersFile('inv-owner', tourId))?.members).toHaveLength(1);
  });

  it('refuses someone signed in with another address, and says which one it is for', async () => {
    const { tourId } = await tourOf('wrong-owner');
    const { token } = await invite('wrong-owner', tourId, emailOf('wrong-ed'));
    const r = await accept('wrong-other', token);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'wrong account', email: emailOf('wrong-ed') });
    expect((await membersFile('wrong-owner', tourId))?.members).toEqual([]);
  });

  it('refuses a sign-in without a verified email', async () => {
    const { tourId } = await tourOf('noem-owner');
    const { token } = await invite('noem-owner', tourId, emailOf('noem-ed'));
    const r = await accept('noemail:noem-ed', token);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'no verified email', email: emailOf('noem-ed') });
  });

  it('refuses a made-up, revoked or replaced link', async () => {
    const { tourId } = await tourOf('rev-owner');
    const first = await invite('rev-owner', tourId, emailOf('rev-ed'));
    const fake = `${tourId}.${'A'.repeat(43)}`;
    expect((await accept('rev-ed', fake)).status).toBe(404);
    expect((await accept('rev-ed', 'nonsense')).status).toBe(404);

    // Inviting the same address again replaces the link.
    const second = await invite('rev-owner', tourId, emailOf('rev-ed'));
    expect((await accept('rev-ed', first.token)).status).toBe(404);
    const del = await api('rev-owner', 'DELETE', `/tours/${tourId}/invites/${second.invite.id}`);
    expect(del.status).toBe(204);
    expect((await accept('rev-ed', second.token)).status).toBe(404);
    // Nothing left: an empty file (a delete could drop a racing write), granting nothing.
    expect(await membersFile('rev-owner', tourId)).toMatchObject({ members: [], invites: [] });
  });

  it(`stops working after ${INVITE_DAYS} days`, async () => {
    const { tourId } = await tourOf('exp-owner');
    const { token } = await invite('exp-owner', tourId, emailOf('exp-ed'));
    vi.useFakeTimers({ now: Date.now() + INVITE_DAYS * 24 * 3600 * 1000 + 1000, toFake: ['Date'] });
    const r = await accept('exp-ed', token);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: 'invite expired', email: emailOf('exp-ed') });
  });

  it('takes no one on while the owner is disabled', async () => {
    const { tourId } = await tourOf('acc-dis-owner');
    const { token } = await invite('acc-dis-owner', tourId, emailOf('acc-dis-ed'));
    await env.BUCKET.put(accountDisabledKey(subOf('acc-dis-owner')), '{}');
    expect((await accept('acc-dis-ed', token)).status).toBe(404);
  });

  it("is the owner's alone to send, and never to themselves or an editor twice", async () => {
    const { tourId } = await sharedTour('only-owner', 'only-ed');
    const byEditor = await api('only-ed', 'POST', `/tours/${tourId}/invites`, {
      email: 'x@example.com',
    });
    expect(byEditor.status).toBe(403);
    const byStranger = await api('only-x', 'POST', `/tours/${tourId}/invites`, {
      email: 'x@example.com',
    });
    expect(byStranger.status).toBe(404);
    const self = await api('only-owner', 'POST', `/tours/${tourId}/invites`, {
      email: emailOf('only-owner'),
    });
    expect(self.status).toBe(400);
    const again = await api('only-owner', 'POST', `/tours/${tourId}/invites`, {
      email: emailOf('only-ed'),
    });
    expect(again.status).toBe(409);
    const bad = await api('only-owner', 'POST', `/tours/${tourId}/invites`, { email: 'nope' });
    expect(bad.status).toBe(400);
  });

  it(`holds at most ${MAX_TOUR_MEMBERS} editors and invites`, async () => {
    const { tourId } = await tourOf('full-owner');
    for (let i = 0; i < MAX_TOUR_MEMBERS; i++) {
      await invite('full-owner', tourId, `full-${i}@example.com`);
    }
    const r = await api('full-owner', 'POST', `/tours/${tourId}/invites`, {
      email: 'one-more@example.com',
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'tour full' });
  });

  it("refuses the owner's own link", async () => {
    const { tourId } = await tourOf('ownlink');
    const { token } = await invite('ownlink', tourId, 'someone@example.com');
    const r = await accept('ownlink', token);
    expect(r.status).toBe(409);
  });
});

describe('what an editor can do', () => {
  it('opens and saves the tour, which stays in the owner account', async () => {
    const { tourId, panoId } = await sharedTour('ed-owner', 'ed-ed');
    const got = await api('ed-ed', 'GET', `/tours/${tourId}?include=configs`);
    expect(got.status).toBe(200);
    const body = await json<TourOk & { configs: Record<string, unknown> }>(got);
    expect(body.role).toBe('editor');
    expect(Object.keys(body.configs)).toEqual([panoId]);
    const own = await json<TourOk>(await api('ed-owner', 'GET', `/tours/${tourId}`));
    expect(own.role).toBe('owner');

    const put = await api(
      'ed-ed',
      'PUT',
      `/tours/${tourId}`,
      { title: 'Edited by the editor', scenes: [{ panoId }] },
      { 'If-Match': body.etag },
    );
    expect(put.status).toBe(200);
    const stored = await env.BUCKET.get(tourKey(subOf('ed-owner'), tourId));
    expect(((await stored?.json()) as { title: string }).title).toBe('Edited by the editor');
    expect(await env.BUCKET.head(tourKey(subOf('ed-ed'), tourId))).toBeNull();
  });

  it("edits a scene's config and creates one for a fresh upload, but no other pano", async () => {
    const { tourId, panoId } = await sharedTour('cfg-owner', 'cfg-ed');
    const inTour = await api('cfg-ed', 'PUT', `/panos/${panoId}/config?tourId=${tourId}`, {
      title: 'Renamed scene',
      hotspots: [],
    });
    expect(inTour.status).toBe(200);
    expect(
      (
        (await (await env.BUCKET.get(configKey(subOf('cfg-owner'), panoId)))?.json()) as {
          title: string;
        }
      ).title,
    ).toBe('Renamed scene');

    // A fresh upload in the owner's account, not in the tour yet: its first config only.
    await editorUpload('cfg-owner', 'cfg-ed', tourId, 'cfg-fresh');
    const create = await api(
      'cfg-ed',
      'PUT',
      `/panos/cfg-fresh/config?tourId=${tourId}`,
      { title: 'Fresh', hotspots: [] },
      { 'If-Match': '', 'If-None-Match': '*' },
    );
    expect(create.status).toBe(200);
    const status = await api('cfg-ed', 'GET', `/panos/cfg-fresh?tourId=${tourId}&status=1`);
    // Still theirs to reach before Save adds it: it was uploaded for this tour.
    expect(status.status).toBe(200);

    // Another of the owner's panos, configured, in no tour the editor has.
    await readyPano('cfg-owner', 'cfg-other');
    const other = await api('cfg-ed', 'PUT', `/panos/cfg-other/config?tourId=${tourId}`, {
      title: 'Hijack',
      hotspots: [],
    });
    expect(other.status).toBe(404);
    // Nor one with no config yet that no editor uploaded for this tour.
    await env.BUCKET.put(originalKey(subOf('cfg-owner'), 'cfg-bare'), 'bytes');
    const bare = await api('cfg-ed', 'GET', `/panos/cfg-bare?tourId=${tourId}&status=1`);
    expect(bare.status).toBe(404);
    // Without the tourId it is their own (empty) account.
    expect((await api('cfg-ed', 'GET', `/panos/${panoId}`)).status).toBe(404);
  });

  it("adds only panos they uploaded for this tour, never the owner's others", async () => {
    const { tourId, panoId } = await sharedTour('add-owner', 'add-ed');
    // The owner's pano in another, unshared tour: its id is public once that tour is.
    await readyPano('add-owner', 'add-secret');
    const r = await api('add-owner', 'POST', '/tours', {
      title: 'Other',
      scenes: [{ panoId: 'add-secret' }],
    });
    expect(r.status).toBe(201);
    const put = (scenes: string[]) =>
      api('add-ed', 'PUT', `/tours/${tourId}`, {
        title: 'Shared',
        scenes: scenes.map((id) => ({ panoId: id })),
      });

    const sneak = await put([panoId, 'add-secret']);
    expect(sneak.status).toBe(403);
    expect(await sneak.json()).toEqual({ error: 'pano not found', panoIds: ['add-secret'] });
    const config = await api('add-ed', 'PUT', `/panos/add-secret/config?tourId=${tourId}`, {
      title: 'Hijack',
      hotspots: [],
    });
    expect(config.status).toBe(404);

    // Uploaded for another tour: still not this one's.
    await editorUpload('add-owner', 'add-ed', 'some-other-tour', 'add-elsewhere');
    expect((await put([panoId, 'add-elsewhere'])).status).toBe(403);

    // Their own upload for this tour goes in; scenes already there stay, and can be dropped.
    await editorUpload('add-owner', 'add-ed', tourId, 'add-mine');
    expect((await put([panoId, 'add-mine'])).status).toBe(200);
    expect((await put(['add-mine'])).status).toBe(200);
    // Once out, the owner's pano is like any other: an editor can't put it back.
    expect((await put(['add-mine', panoId])).status).toBe(403);
    // The owner adds whatever they like.
    const owner = await api('add-owner', 'PUT', `/tours/${tourId}`, {
      title: 'Shared',
      scenes: [{ panoId: 'add-mine' }, { panoId: 'add-secret' }],
    });
    expect(owner.status).toBe(200);
  });

  it("checks an editor's If-Match against the tour it vets", async () => {
    const { tourId, panoId } = await sharedTour('etag-owner', 'etag-ed');
    const r = await api(
      'etag-ed',
      'PUT',
      `/tours/${tourId}`,
      { title: 'x', scenes: [{ panoId }] },
      { 'If-Match': '"stale"' },
    );
    expect(r.status).toBe(412);
  });

  it('republishes on Save but leaves the share link and sharing to the owner', async () => {
    const { tourId } = await sharedTour('pub-owner', 'pub-ed');
    expect((await api('pub-owner', 'POST', `/tours/${tourId}/publish`, {})).status).toBe(200);
    const afterSave = await api('pub-ed', 'POST', `/tours/${tourId}/publish`, { afterSave: true });
    expect(afterSave.status).toBe(200);
    for (const body of [
      {},
      { afterSave: true, slug: 'mine-now' },
      { afterSave: true, visibility: 'public' },
    ]) {
      expect((await api('pub-ed', 'POST', `/tours/${tourId}/publish`, body)).status).toBe(403);
    }
    expect((await api('pub-ed', 'PUT', `/tours/${tourId}/slug`, { slug: 'mine-now' })).status).toBe(
      404,
    );
    expect(
      (await api('pub-ed', 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'public' }))
        .status,
    ).toBe(404);
    expect((await api('pub-ed', 'DELETE', `/tours/${tourId}/publish`)).status).toBe(204);
    // That unpublish was a no-op for the editor: still shared.
    expect(await env.BUCKET.head(publishKey(subOf('pub-owner'), tourId))).not.toBeNull();
  });

  it("can't delete the tour or the owner's panos", async () => {
    const { tourId, panoId } = await sharedTour('del-owner', 'del-ed');
    expect((await api('del-ed', 'DELETE', `/tours/${tourId}`)).status).toBe(204);
    expect(await env.BUCKET.head(tourKey(subOf('del-owner'), tourId))).not.toBeNull();
    expect((await api('del-ed', 'DELETE', `/panos/${panoId}`)).status).toBe(404);
    expect(await env.BUCKET.head(originalKey(subOf('del-owner'), panoId))).not.toBeNull();
  });

  it('loses write access while the owner is disabled', async () => {
    const { tourId, panoId } = await sharedTour('dis-owner', 'dis-ed');
    await env.BUCKET.put(accountDisabledKey(subOf('dis-owner')), '{}');
    const got = await api('dis-ed', 'GET', `/tours/${tourId}`);
    expect(got.status).toBe(200);
    const put = await api('dis-ed', 'PUT', `/tours/${tourId}`, {
      title: 'x',
      scenes: [{ panoId }],
    });
    expect(put.status).toBe(403);
  });

  it('sees no insights once the owner is being deleted', async () => {
    const { tourId } = await sharedTour('ins-owner', 'ins-ed');
    await env.BUCKET.put(accountDeletionKey(subOf('ins-owner')), '{}');
    expect((await api('ins-ed', 'GET', `/tours/${tourId}/insights`)).status).toBe(404);
  });

  it('sees no other tour of the owner', async () => {
    const { tourId: shared } = await sharedTour('iso-owner', 'iso-ed');
    const r = await api('iso-owner', 'POST', '/tours', { title: 'Private', scenes: [] });
    const { tourId: other } = await json<{ tourId: string }>(r);
    // Its pointer exists only once it is published or shared; write one to be sure.
    await env.BUCKET.put(tourOwnerKey(other), JSON.stringify({ v: 1, sub: subOf('iso-owner') }));
    expect((await api('iso-ed', 'GET', `/tours/${shared}`)).status).toBe(200);
    expect((await api('iso-ed', 'GET', `/tours/${other}`)).status).toBe(404);
    expect((await api('iso-ed', 'GET', `/tours/${other}/members`)).status).toBe(404);
  });
});

describe('the People list', () => {
  it('shows the owner everything and an editor no invites, never anyone’s sub', async () => {
    const { tourId } = await sharedTour('ppl-owner', 'ppl-ed');
    await invite('ppl-owner', tourId, 'pending@example.com');
    const owner = await json<MembersOk>(await api('ppl-owner', 'GET', `/tours/${tourId}/members`));
    expect(owner.role).toBe('owner');
    expect(owner.ownerEmail).toBe(emailOf('ppl-owner'));
    expect(owner.members.map((m) => m.email)).toEqual([emailOf('ppl-ed')]);
    expect(owner.invites.map((i) => i.email)).toEqual(['pending@example.com']);
    expect(JSON.stringify(owner)).not.toContain('auth0|');
    expect(JSON.stringify(owner)).not.toContain('tokenHash');
    const editor = await json<MembersOk>(await api('ppl-ed', 'GET', `/tours/${tourId}/members`));
    expect(editor.role).toBe('editor');
    expect(editor.invites).toEqual([]);
    // Each caller finds their own entry by `you`, never by a sub.
    expect(owner.members.map((m) => m.you)).toEqual([false]);
    expect(editor.members.map((m) => m.you)).toEqual([true]);
  });

  it('lets the owner remove an editor, and an editor leave but not remove others', async () => {
    const { tourId } = await sharedTour('rm-owner', 'rm-a');
    const { token } = await invite('rm-owner', tourId, emailOf('rm-b'));
    await accept('rm-b', token);
    const list = await json<MembersOk>(await api('rm-owner', 'GET', `/tours/${tourId}/members`));
    const a = list.members.find((m) => m.email === emailOf('rm-a'))!;
    const b = list.members.find((m) => m.email === emailOf('rm-b'))!;

    expect((await api('rm-a', 'DELETE', `/tours/${tourId}/members/${b.id}`)).status).toBe(403);
    expect((await api('rm-a', 'DELETE', `/tours/${tourId}/members/${a.id}`)).status).toBe(204);
    expect((await api('rm-a', 'GET', `/tours/${tourId}`)).status).toBe(404);
    expect(await env.BUCKET.head(membershipKey(subOf('rm-a'), tourId))).toBeNull();

    expect((await api('rm-owner', 'DELETE', `/tours/${tourId}/members/${b.id}`)).status).toBe(204);
    expect((await api('rm-b', 'GET', `/tours/${tourId}`)).status).toBe(404);
  });
});

describe('shared tours on the dashboard', () => {
  it('lists the tours someone edits and forgets ones they lost', async () => {
    const { tourId: kept } = await sharedTour('dash-o1', 'dash-ed');
    const { tourId: lost } = await sharedTour('dash-o2', 'dash-ed');
    const before = await json<SharedToursOk>(await api('dash-ed', 'GET', '/shared-tours'));
    expect(before.tours.map((t) => t.tourId).sort()).toEqual([kept, lost].sort());
    expect(before.tours.find((t) => t.tourId === kept)).toMatchObject({
      title: 'Tour of dash-o1',
      sceneCount: 1,
      ownerEmail: emailOf('dash-o1'),
    });

    // The owner removes them behind the index's back.
    await env.BUCKET.delete(membersKey(subOf('dash-o2'), lost));
    const after = await json<SharedToursOk>(await api('dash-ed', 'GET', '/shared-tours'));
    expect(after.tours.map((t) => t.tourId)).toEqual([kept]);
    // The stale entry is cleaned up.
    await vi.waitFor(async () =>
      expect(await env.BUCKET.head(membershipKey(subOf('dash-ed'), lost))).toBeNull(),
    );
  });

  it('heals a lost index entry when the editor opens the tour', async () => {
    const { tourId } = await sharedTour('heal-owner', 'heal-ed');
    await env.BUCKET.delete(membershipKey(subOf('heal-ed'), tourId));
    expect((await api('heal-ed', 'GET', `/tours/${tourId}`)).status).toBe(200);
    await vi.waitFor(async () =>
      expect(await env.BUCKET.head(membershipKey(subOf('heal-ed'), tourId))).not.toBeNull(),
    );
  });
});

describe('deletion', () => {
  it("drops the editors' entries with the tour", async () => {
    const { tourId } = await sharedTour('tdel-owner', 'tdel-ed');
    expect((await api('tdel-owner', 'DELETE', `/tours/${tourId}`)).status).toBe(204);
    expect(await env.BUCKET.head(membersKey(subOf('tdel-owner'), tourId))).toBeNull();
    expect(await env.BUCKET.head(membershipKey(subOf('tdel-ed'), tourId))).toBeNull();
    expect((await api('tdel-ed', 'GET', `/tours/${tourId}`)).status).toBe(404);
  });

  it("takes a deleted editor off the owner's tours", async () => {
    const { tourId } = await sharedTour('adel-owner', 'adel-ed');
    const r = await api('adel-ed', 'DELETE', '/account', { confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(r.status).toBe(200);
    expect((await membersFile('adel-owner', tourId))?.members ?? []).toEqual([]);
    expect(await env.BUCKET.head(membershipKey(subOf('adel-ed'), tourId))).toBeNull();
    // The owner's tour is untouched.
    expect(await env.BUCKET.head(tourKey(subOf('adel-owner'), tourId))).not.toBeNull();
  });

  it("closes an owner's tours to their editors", async () => {
    const { tourId } = await sharedTour('odel-owner', 'odel-ed');
    await editorUpload('odel-owner', 'odel-ed', tourId, 'odel-up');
    const r = await api('odel-owner', 'DELETE', '/account', {
      confirm: ACCOUNT_DELETE_CONFIRMATION,
    });
    expect(r.status).toBe(200);
    expect(await env.BUCKET.head(uploadedForKey(subOf('odel-owner'), 'odel-up'))).toBeNull();
    expect(await env.BUCKET.head(membershipKey(subOf('odel-ed'), tourId))).toBeNull();
    expect((await api('odel-ed', 'GET', `/tours/${tourId}`)).status).toBe(404);
  });
});

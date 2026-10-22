import {
  accountDeletionKey,
  accountDisabledKey,
  configKey,
  encodeId,
  manifestKey,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  planKey,
  publishKey,
  pubTourKey,
  storedSlugKey,
  tourKey,
  tourOwnerKey,
} from '@internal/contracts';
import { R2PreconditionFailedError } from '@internal/worker-kit/r2-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  assertOwnsTour,
  caseRecordKey,
  copyToQuarantine,
  decodeOwner,
  describeOwner,
  disableOwner,
  enableOwner,
  findTourOwner,
  listOwnerTours,
  ownerPanoContent,
  panosWithTiles,
  parseTakedownArgs,
  quarantineKey,
  readOwnerStatus,
  requestTourTakedown,
  runTakedown,
  tourContent,
  tourIdForSlug,
  writeCaseRecord,
  type TakedownStore,
} from './takedown-lib.ts';

const ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'pano-content-dev',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  OPERATOR_TOKEN: 'op-token',
};
const SUB = 'google-oauth2|1234';

describe('parseTakedownArgs', () => {
  it('with only a tour named, reports and touches nothing', () => {
    expect(parseTakedownArgs(['--slug', 'old-town'], ENV)).toMatchObject({
      slug: 'old-town',
      tourAction: undefined,
      ownerAction: undefined,
      dryRun: false,
      api: undefined,
    });
  });

  it('reads a tour action, an owner action and a reason together', () => {
    expect(
      parseTakedownArgs(
        [
          '--tour',
          'tour-1',
          '--delete',
          '--nothing-to-preserve',
          '--disable-owner',
          '--reason',
          'ticket 7',
          '--dry-run',
        ],
        ENV,
      ),
    ).toMatchObject({
      tourId: 'tour-1',
      tourAction: 'delete',
      ownerAction: 'disable',
      reason: 'ticket 7',
      dryRun: true,
      api: { origin: 'https://panote.dev', token: 'op-token' },
    });
  });

  it('takes an owner alone for --disable-owner / --enable-owner, with no API config', () => {
    expect(parseTakedownArgs(['--sub', SUB, '--enable-owner'], ENV)).toMatchObject({
      sub: SUB,
      ownerAction: 'enable',
      api: undefined,
    });
  });

  it.each([
    ['--hide-from-explore', 'hide'],
    ['--show-on-explore', 'unhide'],
  ])('%s is a tour action through the operator route', (flag, action) => {
    expect(parseTakedownArgs(['--slug', 'a', flag], ENV)).toMatchObject({
      tourAction: action,
      api: { origin: 'https://panote.dev', token: 'op-token' },
    });
  });

  it('picks admin-api by bucket, and ADMIN_API_ORIGIN overrides it', () => {
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    const argv = ['--slug', 'x', '--unpublish', '--allow-bucket', 'pano-content'];
    expect(parseTakedownArgs(argv, prod).api?.origin).toBe('https://panote.io');
    expect(
      parseTakedownArgs(argv, { ...prod, ADMIN_API_ORIGIN: 'https://staging.example' }).api?.origin,
    ).toBe('https://staging.example');
  });

  it.each([
    [[], /name a tour/],
    [['--slug', 'a', '--tour', 't'], /exclusive/],
    [['--slug', 'a', '--unpublish', '--delete'], /exclusive/],
    [['--sub', SUB, '--disable-owner', '--enable-owner'], /exclusive/],
    [['--sub', SUB, '--unpublish'], /needs --slug or --tour/],
    [['--slug', 'a', '--unpublish', '--hide-from-explore'], /exclusive/],
    [['--sub', SUB, '--hide-from-explore'], /--hide-from-explore needs --slug or --tour/],
    [['--tour', 'a/b'], /--tour must match/],
    [['--slug', 'Not A Slug'], /not a valid slug/],
    [['--sub', SUB, '--reason', 'x'], /--reason goes with --disable-owner/],
    [['--sub', SUB, '--disable-owner', '--reason', 'x'.repeat(501)], /over 500/],
    [['--sub', ` ${SUB}`], /whitespace/],
    [['--slug'], /needs a value/],
    [['--slug', 'a', '--force'], /unknown argument --force/],
    // Nothing is destroyed without a copy unless the operator says none is needed.
    [['--slug', 'a', '--delete'], /--delete keeps no copy/],
    [['--sub', SUB, '--all-tours', '--delete'], /--delete keeps no copy/],
    [['--slug', 'a', '--quarantine', 'case-1', '--unpublish'], /exclusive/],
    [['--slug', 'a', '--unpublish', '--quarantine', 'case-1'], /exclusive/],
    [['--slug', 'a', '--quarantine', 'Case 1'], /case id/],
    [['--slug', 'a', '--quarantine', 'a/b'], /case id/],
    [['--sub', SUB, '--all-tours'], /--all-tours goes with/],
    [['--sub', SUB, '--quarantine', 'case-1'], /needs --slug or --tour, or --all-tours/],
    [['--sub', SUB, '--close-account'], /--close-account deletes everything/],
    [['--slug', 'a', '--quarantine', 'case-1', '--close-account'], /--close-account deletes/],
    // The owner is blocked before the copy, so they can't write between it and the delete.
    [['--slug', 'a', '--quarantine', 'case-1'], /--quarantine needs --disable-owner/],
    [
      ['--sub', SUB, '--close-account', '--nothing-to-preserve'],
      /--close-account needs --disable-owner/,
    ],
    [['--sub', SUB, '--nothing-to-preserve'], /--nothing-to-preserve goes with/],
    [['--slug', 'a', '--unpublish', '--nothing-to-preserve'], /--nothing-to-preserve goes with/],
    [['--sub', SUB, '--close-account', '--nothing-to-preserve', '--enable-owner'], /exclusive/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseTakedownArgs(argv, ENV)).toThrow(error);
  });

  it('reads an owner-wide quarantine that closes the account', () => {
    expect(
      parseTakedownArgs(
        [
          '--slug',
          'old-town',
          '--all-tours',
          '--quarantine',
          '2026-10-22-report-3',
          '--disable-owner',
          '--close-account',
        ],
        ENV,
      ),
    ).toMatchObject({
      slug: 'old-town',
      tourAction: 'quarantine',
      caseId: '2026-10-22-report-3',
      allTours: true,
      closeAccount: true,
      nothingToPreserve: false,
      ownerAction: 'disable',
      api: { origin: 'https://panote.dev', token: 'op-token' },
    });
  });

  it('takes --all-tours with an owner alone, and --close-account with --nothing-to-preserve', () => {
    expect(parseTakedownArgs(['--sub', SUB, '--all-tours', '--unpublish'], ENV)).toMatchObject({
      sub: SUB,
      allTours: true,
      tourAction: 'unpublish',
    });
    expect(
      parseTakedownArgs(
        ['--sub', SUB, '--close-account', '--nothing-to-preserve', '--disable-owner'],
        ENV,
      ),
    ).toMatchObject({ closeAccount: true, tourAction: undefined, api: undefined });
  });

  it('makes a non-dev bucket be named twice, like delete-account', () => {
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    expect(() => parseTakedownArgs(['--sub', SUB], prod)).toThrow(/--allow-bucket/);
  });

  it('refuses an ADMIN_API_ORIGIN other than the bucket default unless the bucket is named twice', () => {
    const argv = ['--slug', 'a', '--unpublish'];
    const toProd = { ...ENV, ADMIN_API_ORIGIN: 'https://panote.io' };
    expect(() => parseTakedownArgs(argv, toProd)).toThrow(/--allow-bucket pano-content-dev/);
    expect(
      parseTakedownArgs([...argv, '--allow-bucket', 'pano-content-dev'], toProd).api?.origin,
    ).toBe('https://panote.io');
    // Spelling out the default is fine.
    expect(
      parseTakedownArgs(argv, { ...ENV, ADMIN_API_ORIGIN: 'https://panote.dev' }).api?.origin,
    ).toBe('https://panote.dev');
  });

  it('needs OPERATOR_TOKEN and a usable origin only for a tour action', () => {
    const noToken = { ...ENV, OPERATOR_TOKEN: '' };
    expect(() => parseTakedownArgs(['--slug', 'a', '--unpublish'], noToken)).toThrow(
      /OPERATOR_TOKEN/,
    );
    expect(parseTakedownArgs(['--slug', 'a', '--disable-owner'], noToken).ownerAction).toBe(
      'disable',
    );
    const odd = { ...ENV, R2_BUCKET: 'other-dev' };
    expect(() => parseTakedownArgs(['--slug', 'a', '--unpublish'], odd)).toThrow(
      /ADMIN_API_ORIGIN/,
    );
    expect(() =>
      parseTakedownArgs(['--slug', 'a', '--unpublish'], {
        ...ENV,
        ADMIN_API_ORIGIN: 'http://panote.dev',
      }),
    ).toThrow(/https origin/);
  });
});

const bytesOf = (body: string | Uint8Array): Uint8Array =>
  typeof body === 'string' ? new TextEncoder().encode(body) : body;

/** A stand-in for S3's MD5 ETag: 32 hex chars that change with the content. */
function fakeEtag(body: string | Uint8Array): string {
  let h = 2166136261;
  const out: string[] = [];
  for (let round = 0; round < 4; round++) {
    for (const byte of bytesOf(body)) h = Math.imul(h ^ byte, 16777619) >>> 0;
    h = Math.imul(h ^ round, 16777619) >>> 0;
    out.push(h.toString(16).padStart(8, '0'));
  }
  return `"${out.join('')}"`;
}

/** The S3 calls the CLI makes, over a Map. */
function memoryStore(seed: Record<string, string> = {}) {
  const objects = new Map<string, string | Uint8Array>(Object.entries(seed));
  const types = new Map<string, string>();
  const etagOf = (key: string) => {
    const body = objects.get(key);
    return body === undefined ? null : fakeEtag(body);
  };
  const store: TakedownStore = {
    async listPrefixes(prefix) {
      const found = new Set<string>();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) found.add(prefix + rest.slice(0, rest.indexOf('/') + 1));
      }
      return [...found];
    },
    async listObjects(prefix) {
      return [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: bytesOf(body).byteLength }));
    },
    async head(key) {
      return { ok: objects.has(key), status: objects.has(key) ? 200 : 404, etag: etagOf(key) };
    },
    async get(key) {
      const body = objects.get(key);
      if (body === undefined) return new Response(null, { status: 404 });
      const type = types.get(key);
      return new Response(body, {
        headers: { etag: etagOf(key)!, ...(type ? { 'content-type': type } : {}) },
      });
    },
    async put(key, body, opts) {
      if (opts.ifNoneMatch === '*' && objects.has(key)) throw new R2PreconditionFailedError(key);
      if (opts.ifMatch !== undefined && opts.ifMatch !== etagOf(key)) {
        throw new R2PreconditionFailedError(key);
      }
      objects.set(key, typeof body === 'string' ? body : body.slice());
      types.set(key, opts.contentType);
    },
    async deleteObject(key) {
      objects.delete(key);
    },
  };
  return { store, objects, types };
}

describe('tourIdForSlug', () => {
  it('follows a live pointer and a redirect alias alike', async () => {
    const { store } = memoryStore({
      [storedSlugKey('live')!]: JSON.stringify({ v: 1, kind: 'tour', tourId: 'tour-1' }),
      [storedSlugKey('old')!]: JSON.stringify({
        v: 1,
        kind: 'redirect',
        tourId: 'tour-1',
        redirect: 'live',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    });
    expect(await tourIdForSlug(store, 'live')).toBe('tour-1');
    expect(await tourIdForSlug(store, 'old')).toBe('tour-1');
  });

  it('says so for a missing or unreadable slug', async () => {
    const { store } = memoryStore({ [storedSlugKey('bad')!]: '{"v":1}' });
    await expect(tourIdForSlug(store, 'gone')).rejects.toThrow(/no share link \/s\/gone/);
    await expect(tourIdForSlug(store, 'bad')).rejects.toThrow(/unreadable/);
  });
});

describe('decodeOwner', () => {
  it('inverts encodeId', () => {
    for (const sub of [SUB, 'auth0|me', 'email|ünïcode', 'a']) {
      expect(decodeOwner(encodeId(sub))).toBe(sub);
    }
  });

  it.each(['', 'a+b', 'a/b', 'a=', 'gA'])('refuses %j, which encodeId never writes', (seg) => {
    expect(decodeOwner(seg)).toBeNull();
  });
});

describe('findTourOwner', () => {
  it('finds the one owner holding the tour, by tour.json or publish.json', async () => {
    const { store } = memoryStore({
      [tourKey('auth0|other', 'other-tour')]: '{}',
      [tourKey(SUB, 'tour-1')]: '{}',
      [publishKey('auth0|pub-only', 'tour-2')]: '{}',
    });
    expect(await findTourOwner(store, 'tour-1')).toBe(SUB);
    expect(await findTourOwner(store, 'tour-2')).toBe('auth0|pub-only');
  });

  it("uses admin-api's owner pointer instead of scanning every owner", async () => {
    const { store } = memoryStore({
      [tourKey(SUB, 'tour-1')]: '{}',
      [tourOwnerKey('tour-1')]: JSON.stringify({ v: 1, sub: SUB }),
    });
    const scan = vi.spyOn(store, 'listPrefixes');
    expect(await findTourOwner(store, 'tour-1')).toBe(SUB);
    expect(scan).not.toHaveBeenCalled();
  });

  it('falls back to the scan for a pointer that is stale or unreadable', async () => {
    const { store } = memoryStore({
      [tourKey(SUB, 'tour-1')]: '{}',
      [tourOwnerKey('tour-1')]: JSON.stringify({ v: 1, sub: 'auth0|someone-else' }),
      [publishKey(SUB, 'tour-2')]: '{}',
      [tourOwnerKey('tour-2')]: 'junk',
    });
    const scan = vi.spyOn(store, 'listPrefixes');
    expect(await findTourOwner(store, 'tour-1')).toBe(SUB);
    expect(await findTourOwner(store, 'tour-2')).toBe(SUB);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('throws when no owner has it', async () => {
    const { store } = memoryStore({ [tourKey(SUB, 'tour-1')]: '{}' });
    await expect(findTourOwner(store, 'tour-9')).rejects.toThrow(/no owner has tour tour-9/);
  });

  it('throws rather than guess when R2 gives no clear answer', async () => {
    const { store } = memoryStore({ [tourKey(SUB, 'tour-1')]: '{}' });
    store.head = async () => ({ ok: false, status: 503, etag: null });
    await expect(findTourOwner(store, 'tour-1')).rejects.toThrow(/503/);
  });
});

describe('assertOwnsTour', () => {
  it('passes for the owner, by tour.json or publish.json', async () => {
    const { store } = memoryStore({
      [tourKey(SUB, 'tour-1')]: '{}',
      [publishKey(SUB, 'tour-2')]: '{}',
    });
    await expect(assertOwnsTour(store, SUB, 'tour-1')).resolves.toBeUndefined();
    await expect(assertOwnsTour(store, SUB, 'tour-2')).resolves.toBeUndefined();
  });

  it('refuses a --sub that is not the owner, so a typo disables nobody', async () => {
    const { store } = memoryStore({ [tourKey(SUB, 'tour-1')]: '{}' });
    await expect(assertOwnsTour(store, 'google-oauth2|1235', 'tour-1')).rejects.toThrow(
      /doesn't own tour tour-1/,
    );
  });
});

describe('disable / enable owner', () => {
  const now = new Date('2026-10-21T09:00:00.000Z');

  it('writes the marker admin-api and upload-api check, and removes it again', async () => {
    const { store, objects } = memoryStore();
    expect(await readOwnerStatus(store, SUB)).toEqual({ disabled: null, deletionRequested: false });

    await disableOwner(store, SUB, now, 'ticket 7');
    expect(JSON.parse(objects.get(accountDisabledKey(SUB)) as string)).toEqual({
      v: 1,
      disabledAt: now.toISOString(),
      reason: 'ticket 7',
    });
    const status = await readOwnerStatus(store, SUB);
    expect(describeOwner(SUB, status)).toBe(
      `owner ${SUB}: disabled since ${now.toISOString()} (ticket 7)`,
    );

    await enableOwner(store, SUB);
    expect(objects.has(accountDisabledKey(SUB))).toBe(false);
  });

  it('leaves the deletion marker alone and reports it', async () => {
    const { store, objects } = memoryStore({ [accountDeletionKey(SUB)]: '{}' });
    await disableOwner(store, SUB, now, undefined);
    expect(objects.has(accountDeletionKey(SUB))).toBe(true);
    const status = await readOwnerStatus(store, SUB);
    expect(status.disabled).toEqual({ v: 1, disabledAt: now.toISOString() });
    expect(describeOwner(SUB, status)).toMatch(/account deletion requested$/);
  });

  it('reports an unreadable marker as disabled, since it still blocks', async () => {
    const { store } = memoryStore({ [accountDisabledKey(SUB)]: 'junk' });
    expect((await readOwnerStatus(store, SUB)).disabled).not.toBeNull();
  });
});

describe('requestTourTakedown', () => {
  const api = { origin: 'https://panote.dev', token: 'op-token' };
  const body = { sub: SUB, tourId: 'tour-1', action: 'unpublish' as const };

  it('POSTs to the operator route with the token header', async () => {
    const fetchFn = vi.fn(async () => Response.json({ action: 'unpublish', purged: 2 }));
    expect(await requestTourTakedown(fetchFn, api, body)).toEqual({
      action: 'unpublish',
      purged: 2,
    });
    expect(fetchFn).toHaveBeenCalledWith(`https://panote.dev${OPERATOR_TAKEDOWN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [OPERATOR_TOKEN_HEADER]: 'op-token' },
      body: JSON.stringify(body),
    });
  });

  it('points at the token on a bare 404, and passes other errors through', async () => {
    await expect(
      requestTourTakedown(
        async () => Response.json({ error: 'not found' }, { status: 404 }),
        api,
        body,
      ),
    ).rejects.toThrow(/check OPERATOR_TOKEN/);
    await expect(
      requestTourTakedown(
        async () => Response.json({ error: 'tour not found' }, { status: 404 }),
        api,
        body,
      ),
    ).rejects.toThrow(/404 "tour not found"$/);
  });

  it('refuses a 200 that is not the route answering (an Access login page, say)', async () => {
    await expect(
      requestTourTakedown(async () => new Response('<html>'), api, body),
    ).rejects.toThrow(/unexpected response/);
  });
});

describe('owner-wide listing', () => {
  it('lists the owner’s tours and panos, and nobody else’s', async () => {
    const { store } = memoryStore({
      [tourKey(SUB, 'tour-1')]: '{}',
      [publishKey(SUB, 'tour-2')]: '{}',
      [tourKey('auth0|other', 'tour-3')]: '{}',
      [originalKey(SUB, 'pano-1')]: 'x',
      [configKey(SUB, 'pano-2')]: '{}',
      [originalKey('auth0|other', 'pano-3')]: 'x',
    });
    expect((await listOwnerTours(store, SUB)).sort()).toEqual(['tour-1', 'tour-2']);
    const panos = await ownerPanoContent(store, SUB);
    expect(panos.panoIds.sort()).toEqual(['pano-1', 'pano-2']);
    expect(panos.keys).toContain(originalKey(SUB, 'pano-1'));
    expect(panos.keys).toContain(configKey(SUB, 'pano-2'));
  });
});

describe('quarantine', () => {
  const CASE = '2026-10-22-report-3';

  /** A published tour whose bundle still shows a scene since removed from the tour. */
  const seed = () =>
    memoryStore({
      [tourKey(SUB, 'tour-1')]: JSON.stringify({ tourId: 'tour-1', scenes: [{ panoId: 'p-1' }] }),
      [publishKey(SUB, 'tour-1')]: JSON.stringify({
        slug: 'live',
        visibility: 'public',
        publishedAt: '2026-10-01T00:00:00.000Z',
        aliases: ['old'],
      }),
      [pubTourKey('tour-1')]: JSON.stringify({ scenes: [{ panoId: 'p-1' }, { panoId: 'p-2' }] }),
      [storedSlugKey('live')!]: JSON.stringify({ v: 1, kind: 'tour', tourId: 'tour-1' }),
      [originalKey(SUB, 'p-1')]: 'original one',
      [configKey(SUB, 'p-1')]: '{}',
      [originalKey(SUB, 'p-2')]: 'original two',
    });

  it('collects the tour, its publish record, bundle, share links and every scene it showed', async () => {
    const { store } = seed();
    const content = await tourContent(store, SUB, 'tour-1');
    expect(content.panoIds).toEqual(['p-1', 'p-2']);
    expect(content.keys).toEqual([
      tourKey(SUB, 'tour-1'),
      publishKey(SUB, 'tour-1'),
      pubTourKey('tour-1'),
      storedSlugKey('live'),
      storedSlugKey('old'),
      originalKey(SUB, 'p-1'),
      configKey(SUB, 'p-1'),
      originalKey(SUB, 'p-2'),
      configKey(SUB, 'p-2'),
    ]);
  });

  it('collects every floor-plan image under the tour, named or not, and no other tour’s', async () => {
    const plan = (id: string) => ({ id, type: 'image/webp', width: 10, height: 10 });
    const replaced = planKey('tour-p', 'replaced', 'image/png');
    const { store } = memoryStore({
      [tourKey(SUB, 'tour-p')]: JSON.stringify({ tourId: 'tour-p', scenes: [], plan: plan('new') }),
      [pubTourKey('tour-p')]: JSON.stringify({ scenes: [], plan: plan('old') }),
      [planKey('tour-p', 'new', 'image/webp')]: 'img',
      [planKey('tour-p', 'old', 'image/webp')]: 'img',
      // Replaced or never saved: named by neither, but the tour's delete takes it too.
      [replaced]: 'img',
      [planKey('tour-q', 'theirs', 'image/webp')]: 'img',
    });
    const { keys } = await tourContent(store, SUB, 'tour-p');
    expect(keys.filter((k) => k.startsWith('pub/plans/')).sort()).toEqual(
      [
        planKey('tour-p', 'new', 'image/webp'),
        planKey('tour-p', 'old', 'image/webp'),
        replaced,
      ].sort(),
    );
  });

  it('copies each object byte for byte under quarantine/<caseId>/, keeping its content type', async () => {
    const { store, objects, types } = seed();
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x01]);
    objects.set(originalKey(SUB, 'p-1'), bytes);
    types.set(originalKey(SUB, 'p-1'), 'image/jpeg');
    expect(await copyToQuarantine(store, CASE, originalKey(SUB, 'p-1'))).toBe(true);
    const dest = quarantineKey(CASE, originalKey(SUB, 'p-1'));
    expect(dest).toBe(`quarantine/${CASE}/${originalKey(SUB, 'p-1')}`);
    expect(objects.get(dest)).toEqual(bytes);
    expect(types.get(dest)).toBe('image/jpeg');
    // The source is untouched: removing it is a separate step.
    expect(objects.get(originalKey(SUB, 'p-1'))).toEqual(bytes);
  });

  it('skips what is not there, and keeps a matching first copy on a rerun', async () => {
    const { store, objects } = seed();
    expect(await copyToQuarantine(store, CASE, configKey(SUB, 'p-2'))).toBe(false);
    await copyToQuarantine(store, CASE, originalKey(SUB, 'p-2'));
    const first = objects.get(quarantineKey(CASE, originalKey(SUB, 'p-2')));
    expect(await copyToQuarantine(store, CASE, originalKey(SUB, 'p-2'))).toBe(true);
    expect(objects.get(quarantineKey(CASE, originalKey(SUB, 'p-2')))).toBe(first);
    // The source changed since: the old copy no longer vouches for it.
    objects.set(originalKey(SUB, 'p-2'), 'changed since');
    await expect(copyToQuarantine(store, CASE, originalKey(SUB, 'p-2'))).rejects.toThrow(
      /pick a new case id/,
    );
  });

  it('throws rather than report a copy that is not there', async () => {
    const { store } = seed();
    store.put = async () => {};
    await expect(copyToQuarantine(store, CASE, originalKey(SUB, 'p-1'))).rejects.toThrow(
      /quarantine copy .* is missing/,
    );
    const failing = seed().store;
    failing.get = async () => new Response(null, { status: 503 });
    await expect(copyToQuarantine(failing, CASE, originalKey(SUB, 'p-1'))).rejects.toThrow(/503/);
  });

  it('throws on a copy that came out short or different', async () => {
    const short = seed();
    const realShort = short.store.put.bind(short.store);
    short.store.put = (key, body, opts) => realShort(key, body.slice(1), opts);
    await expect(copyToQuarantine(short.store, CASE, originalKey(SUB, 'p-1'))).rejects.toThrow(
      /is 11 bytes, not 12/,
    );
    const changed = seed();
    const realChanged = changed.store.put.bind(changed.store);
    changed.store.put = (key, body, opts) =>
      realChanged(key, typeof body === 'string' ? body : body.map((b, i) => (i ? b : b ^ 1)), opts);
    await expect(copyToQuarantine(changed.store, CASE, originalKey(SUB, 'p-1'))).rejects.toThrow(
      /differs/,
    );
  });

  it('on a rerun, refuses an existing copy that is short or different, and keeps it', async () => {
    const { store, objects } = seed();
    const dest = quarantineKey(CASE, originalKey(SUB, 'p-1'));
    objects.set(dest, 'original on'); // short: a run that failed its check
    await expect(copyToQuarantine(store, CASE, originalKey(SUB, 'p-1'))).rejects.toThrow(
      /existing quarantine copy .* is 11 bytes, not 12; keep it and pick a new case id/,
    );
    objects.set(dest, 'ORIGINAL ONE'); // same size, other bytes
    await expect(copyToQuarantine(store, CASE, originalKey(SUB, 'p-1'))).rejects.toThrow(
      /existing quarantine copy .* differs .*pick a new case id/,
    );
    expect(objects.get(dest)).toBe('ORIGINAL ONE');
  });

  it('refuses an unreadable case record, and one changed while it was being written', async () => {
    const unreadable = seed();
    unreadable.objects.set(caseRecordKey(CASE), '{"v":1}');
    await expect(
      writeCaseRecord(
        unreadable.store,
        CASE,
        { sub: SUB, tourIds: [], keys: [], reason: undefined },
        new Date(),
      ),
    ).rejects.toThrow(/unreadable/);

    const raced = seed();
    const add = { sub: SUB, tourIds: ['tour-1'], keys: ['a'], reason: undefined };
    await writeCaseRecord(raced.store, CASE, add, new Date());
    const real = raced.store.put.bind(raced.store);
    raced.store.put = async (key, body, opts) => {
      // Another run on the same case writes first.
      raced.objects.set(key, JSON.stringify({ ...JSON.parse(body as string), keys: ['other'] }));
      await real(key, body, opts);
    };
    await expect(writeCaseRecord(raced.store, CASE, add, new Date())).rejects.toThrow(
      /changed while this run was writing it/,
    );
  });

  it('keeps one case record per case, adding to it and refusing another owner', async () => {
    const { store, objects } = seed();
    const t1 = new Date('2026-10-22T09:00:00.000Z');
    const t2 = new Date('2026-10-22T10:00:00.000Z');
    await writeCaseRecord(
      store,
      CASE,
      { sub: SUB, tourIds: ['tour-1'], keys: ['a'], reason: 'r' },
      t1,
    );
    const record = await writeCaseRecord(
      store,
      CASE,
      { sub: SUB, tourIds: ['tour-2'], keys: ['a', 'b'], reason: undefined },
      t2,
    );
    expect(record).toEqual({
      v: 1,
      caseId: CASE,
      sub: SUB,
      tourIds: ['tour-1', 'tour-2'],
      keys: ['a', 'b'],
      firstAt: t1.toISOString(),
      lastAt: t2.toISOString(),
      reason: 'r',
    });
    expect(JSON.parse(objects.get(caseRecordKey(CASE)) as string)).toEqual(record);
    await expect(
      writeCaseRecord(
        store,
        CASE,
        { sub: 'auth0|other', tourIds: [], keys: [], reason: undefined },
        t2,
      ),
    ).rejects.toThrow(/another owner/);
  });

  it('reports which panos still have public tiles', async () => {
    const { store } = memoryStore({ [manifestKey('p-1')]: '{}' });
    expect(await panosWithTiles(store, ['p-1', 'p-2'])).toEqual(['p-1']);
  });
});

describe('runTakedown', () => {
  const CASE = 'case-run';
  const ARGV = ['--slug', 'live', '--disable-owner', '--all-tours', '--quarantine', CASE];

  const seed = () => {
    const m = memoryStore({
      [storedSlugKey('live')!]: JSON.stringify({ v: 1, kind: 'tour', tourId: 'tour-1' }),
      [tourOwnerKey('tour-1')]: JSON.stringify({ v: 1, sub: SUB }),
      [tourKey(SUB, 'tour-1')]: JSON.stringify({ scenes: [{ panoId: 'p-1' }] }),
      [tourKey(SUB, 'tour-2')]: JSON.stringify({ scenes: [{ panoId: 'p-1' }] }),
      [originalKey(SUB, 'p-1')]: 'original one',
      [originalKey(SUB, 'p-loose')]: 'in no tour',
    });
    const events: string[] = [];
    const realPut = m.store.put.bind(m.store);
    m.store.put = async (key, body, opts) => {
      events.push(`put ${key}`);
      await realPut(key, body, opts);
    };
    const fetchFn = vi.fn(async (_input: string, init: RequestInit) => {
      const { tourId } = JSON.parse(init.body as string) as { tourId: string };
      events.push(`delete ${tourId}`);
      return Response.json({ action: 'delete', purged: 1 });
    });
    const lines: string[] = [];
    const deps = {
      store: m.store,
      fetch: fetchFn,
      log: (line: string) => lines.push(line),
      now: () => new Date('2026-10-22T09:00:00.000Z'),
    };
    return { ...m, events, fetchFn, lines, deps };
  };

  it('--hide-from-explore asks the route to hide each tour and copies nothing', async () => {
    const t = seed();
    t.fetchFn.mockImplementation(async () => Response.json({ action: 'hide', purged: 0 }));
    await runTakedown(parseTakedownArgs(['--slug', 'live', '--hide-from-explore'], ENV), t.deps);
    expect(t.fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(t.fetchFn.mock.calls[0]![1].body as string)).toEqual({
      sub: SUB,
      tourId: 'tour-1',
      action: 'hide',
    });
    expect(t.events.filter((e) => e.startsWith('put '))).toEqual([]);
    expect(t.lines).toContain('tour tour-1 hidden from Explore; 0 CDN purge target(s) queued');
  });

  it('never asks for a delete when a copy fails', async () => {
    const t = seed();
    const put = t.store.put;
    t.store.put = async (key, body, opts) => {
      if (key === quarantineKey(CASE, originalKey(SUB, 'p-1'))) throw new Error('R2 PUT -> 500');
      await put(key, body, opts);
    };
    await expect(runTakedown(parseTakedownArgs(ARGV, ENV), t.deps)).rejects.toThrow(/500/);
    expect(t.fetchFn).not.toHaveBeenCalled();
    expect(t.objects.has(caseRecordKey(CASE))).toBe(false);
    // The owner was blocked first, and nothing of theirs is gone.
    expect(t.objects.has(accountDisabledKey(SUB))).toBe(true);
    expect(t.objects.has(originalKey(SUB, 'p-1'))).toBe(true);
  });

  it('blocks the owner, copies everything, writes the case, then deletes each tour and closes the account', async () => {
    const t = seed();
    await runTakedown(parseTakedownArgs([...ARGV, '--close-account'], ENV), t.deps);
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    const firstDelete = t.events.findIndex((e) => e.startsWith('delete '));
    expect(t.events[0]).toBe(`put ${accountDisabledKey(SUB)}`);
    expect(t.events.indexOf(`put ${caseRecordKey(CASE)}`)).toBeLessThan(firstDelete);
    expect(t.events.slice(firstDelete)).toEqual([
      'delete tour-1',
      'delete tour-2',
      `put ${accountDeletionKey(SUB)}`,
    ]);
    for (const key of [
      tourKey(SUB, 'tour-1'),
      tourKey(SUB, 'tour-2'),
      originalKey(SUB, 'p-1'),
      originalKey(SUB, 'p-loose'),
    ]) {
      expect([key, t.objects.has(quarantineKey(CASE, key))]).toEqual([key, true]);
    }
  });

  it('a dry run writes nothing and calls nothing', async () => {
    const t = seed();
    await runTakedown(parseTakedownArgs([...ARGV, '--dry-run'], ENV), t.deps);
    expect(t.events).toEqual([]);
    expect(t.fetchFn).not.toHaveBeenCalled();
    expect(t.lines.at(-1)).toMatch(/^DRY RUN: would disable owner, then copy everything/);
  });
});

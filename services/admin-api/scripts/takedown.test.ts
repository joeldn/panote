import {
  accountDeletionKey,
  accountDisabledKey,
  encodeId,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  publishKey,
  storedSlugKey,
  tourKey,
} from '@internal/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  assertOwnsTour,
  decodeOwner,
  describeOwner,
  disableOwner,
  enableOwner,
  findTourOwner,
  parseTakedownArgs,
  readOwnerStatus,
  requestTourTakedown,
  tourIdForSlug,
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
        ['--tour', 'tour-1', '--delete', '--disable-owner', '--reason', 'ticket 7', '--dry-run'],
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
  ])('rejects %j', (argv, error) => {
    expect(() => parseTakedownArgs(argv, ENV)).toThrow(error);
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

/** The S3 calls the CLI makes, over a Map. */
function memoryStore(seed: Record<string, string> = {}) {
  const objects = new Map(Object.entries(seed));
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
    async head(key) {
      return { ok: objects.has(key), status: objects.has(key) ? 200 : 404, etag: null };
    },
    async get(key) {
      const body = objects.get(key);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    },
    async put(key, body) {
      objects.set(key, String(body));
    },
    async deleteObject(key) {
      objects.delete(key);
    },
  };
  return { store, objects };
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
    expect(JSON.parse(objects.get(accountDisabledKey(SUB))!)).toEqual({
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

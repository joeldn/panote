import {
  accountDeletionKey,
  accountDisabledKey,
  configKey,
  deletingKey,
  encodeId,
  originalKey,
  publishKey,
  tourKey,
  trashKey,
} from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import {
  accountStorage,
  formatTable,
  parseStorageArgs,
  runStorage,
  type StorageStore,
} from './account-storage-lib.ts';

const ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'pano-content-dev',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};
const A = 'google-oauth2|alice';
const B = 'auth0|bob';
const MB = 1024 * 1024;

/** A listing-only store over a fixed key -> size map, recording what was listed. */
const storeOf = (objects: Record<string, number>) => {
  const listed: string[] = [];
  const store: StorageStore = {
    async listObjects(prefix) {
      listed.push(prefix);
      return Object.entries(objects)
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, size]) => ({ key, size }));
    },
  };
  return { store, listed };
};

const BUCKET = {
  [originalKey(A, 'a1')]: 40 * MB,
  [configKey(A, 'a1')]: 2_000,
  [originalKey(A, 'a2')]: 10 * MB,
  // Mid-delete: counts toward neither the panos nor the original bytes.
  [originalKey(A, 'a3')]: 99 * MB,
  [deletingKey(A, 'a3')]: 0,
  [tourKey(A, 't1')]: 3_000,
  [publishKey(A, 't1')]: 100,
  [tourKey(A, 't2')]: 1_000,
  [trashKey('2026-10-20', originalKey(A, 'a0'))]: 30 * MB,
  'tiles/a1/t1-x/0/px/0-0.webp': 500_000,
  'tiles/a1/manifest.json': 1_000,
  [originalKey(B, 'b1')]: 5 * MB,
  [accountDeletionKey(B)]: 50,
  [accountDisabledKey(B)]: 50,
  // Not an owner's: never counted.
  'tiles/orphan/manifest.json': 7,
  'pub/tours/t1.json': 9_000,
};

describe('accountStorage', () => {
  it('counts each account’s tours, panos and bytes, largest first', async () => {
    const { store } = storeOf(BUCKET);

    const rows = await accountStorage(store, true);

    expect(rows).toEqual([
      {
        sub: A,
        owner: encodeId(A),
        tours: 2,
        panos: 2,
        originalBytes: 50 * MB,
        panoBytes: 149 * MB + 2_000,
        tourBytes: 4_100,
        trashBytes: 30 * MB,
        tileBytes: 501_000,
        // a2 has an original and no manifest; a3 is mid-delete and not counted.
        untiled: 1,
        deleted: false,
        disabled: false,
      },
      {
        sub: B,
        owner: encodeId(B),
        tours: 0,
        panos: 1,
        originalBytes: 5 * MB,
        panoBytes: 5 * MB,
        tourBytes: 0,
        trashBytes: 0,
        tileBytes: 0,
        untiled: 1,
        deleted: true,
        disabled: true,
      },
    ]);
  });

  it('only lists keys, and lists tiles/ only when asked', async () => {
    const { store, listed } = storeOf(BUCKET);

    const rows = await accountStorage(store, false);

    expect(listed.sort()).toEqual(['accounts/', 'panos/', 'tours/', 'trash/']);
    expect(rows[0]!.tileBytes).toBeNull();
    expect(rows[0]!.untiled).toBeNull();
  });
});

describe('runStorage', () => {
  it('prints a table with totals, or JSON', async () => {
    const lines: string[] = [];
    await runStorage(parseStorageArgs([], ENV), {
      store: storeOf(BUCKET).store,
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toMatch(/^account\s+tours\s+panos\s+originals\s+trash\s+state$/);
    expect(lines[1]).toMatch(
      new RegExp(`^${A.replace('|', '\\|')}\\s+2\\s+2\\s+50\\.0 MB\\s+30\\.0 MB\\s+-$`),
    );
    expect(lines[2]).toMatch(/deleted,disabled$/);
    expect(lines[3]).toMatch(/^2 account\(s\)\s+2\s+3\s+55\.0 MB\s+30\.0 MB$/);

    const json: string[] = [];
    await runStorage(parseStorageArgs(['--json', '--top', '1'], ENV), {
      store: storeOf(BUCKET).store,
      log: (l) => json.push(l),
    });
    const parsed = JSON.parse(json.join('\n')) as { bucket: string; accounts: { sub: string }[] };
    expect(parsed.bucket).toBe('pano-content-dev');
    expect(parsed.accounts.map((a) => a.sub)).toEqual([A]);
  });

  it('says so for an empty bucket, and notes a --top cut', async () => {
    const lines: string[] = [];
    await runStorage(parseStorageArgs([], ENV), {
      store: storeOf({}).store,
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual(['no accounts in pano-content-dev']);

    const top: string[] = [];
    await runStorage(parseStorageArgs(['--top', '1'], ENV), {
      store: storeOf(BUCKET).store,
      log: (l) => top.push(l),
    });
    expect(top.at(-1)).toBe('(the 1 largest of 2 accounts; drop --top for all)');
  });

  it('shows the tiles and untiled columns with --tiles, and the tiles no pano owns', async () => {
    expect(formatTable([], true)[0]).toMatch(/tiles\s+untiled/);
    const lines: string[] = [];
    await runStorage(parseStorageArgs(['--tiles'], ENV), {
      store: storeOf(BUCKET).store,
      log: (l) => lines.push(l),
    });
    expect(lines.at(-1)).toMatch(/^1 tile dir\(s\) under tiles\/ belong to no pano \(7 B\)/);
    const json: string[] = [];
    await runStorage(parseStorageArgs(['--tiles', '--json'], ENV), {
      store: storeOf(BUCKET).store,
      log: (l) => json.push(l),
    });
    expect(JSON.parse(json.join('\n'))).toMatchObject({ orphanTiles: { panos: 1, bytes: 7 } });
  });
});

describe('parseStorageArgs', () => {
  it.each([
    [['--top', '0'], /--top must be/],
    [['--top'], /needs a value/],
    [['--apply'], /unknown argument/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseStorageArgs(argv, ENV)).toThrow(error);
  });

  it('makes a non-dev bucket be named twice', () => {
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    expect(() => parseStorageArgs([], prod)).toThrow(/--allow-bucket/);
    expect(parseStorageArgs(['--allow-bucket', 'pano-content'], prod).r2.bucket).toBe(
      'pano-content',
    );
  });
});

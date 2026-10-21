import { accountDeletionKey } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import {
  describeAccountDeletion,
  parseDeleteAccountArgs,
  readAccountDeletion,
  requestAccountDeletion,
  type MarkerStore,
} from './delete-account-lib.ts';

const ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'pano-content-dev',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};
const SUB = 'google-oauth2|1234';

describe('parseDeleteAccountArgs', () => {
  it('reads the sub and defaults to a real request', () => {
    expect(parseDeleteAccountArgs(['--sub', SUB], ENV)).toMatchObject({
      mode: 'request',
      sub: SUB,
      r2: { bucket: 'pano-content-dev' },
    });
  });

  it.each([
    [['--sub', SUB, '--dry-run'], 'dry-run'],
    [['--status', '--sub', SUB], 'status'],
  ])('%j is %s', (argv, mode) => {
    expect(parseDeleteAccountArgs(argv, ENV).mode).toBe(mode);
  });

  it.each([
    [[], /--sub is required/],
    [['--sub'], /--sub needs a value/],
    [['--sub', '--status'], /--sub needs a value/],
    [['--sub', SUB, '--dry-run', '--status'], /exclusive/],
    [['--sub', SUB, '--force'], /unknown argument --force/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseDeleteAccountArgs(argv, ENV)).toThrow(error);
  });

  it('needs every R2 env var', () => {
    expect(() => parseDeleteAccountArgs(['--sub', SUB], { ...ENV, R2_BUCKET: '' })).toThrow(
      /missing env R2_BUCKET/,
    );
  });

  it('makes a non-dev bucket be named twice', () => {
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    expect(() => parseDeleteAccountArgs(['--sub', SUB], prod)).toThrow(/--allow-bucket/);
    expect(
      parseDeleteAccountArgs(['--sub', SUB, '--allow-bucket', 'pano-content'], prod).r2.bucket,
    ).toBe('pano-content');
  });
});

/** The three S3 calls the CLI makes, over a Map. */
function memoryStore(seed: Record<string, string> = {}) {
  const objects = new Map(Object.entries(seed));
  const puts: string[] = [];
  const store: MarkerStore = {
    async head(key) {
      return { ok: objects.has(key), status: objects.has(key) ? 200 : 404, etag: null };
    },
    async get(key) {
      const body = objects.get(key);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    },
    async put(key, body) {
      puts.push(key);
      objects.set(key, String(body));
    },
  };
  return { store, objects, puts };
}

describe('requestAccountDeletion', () => {
  const now = new Date('2026-10-21T09:00:00.000Z');

  it('writes the same marker the owner route writes', async () => {
    const { store, objects } = memoryStore();
    const out = await requestAccountDeletion(store, SUB, now);
    expect(out.created).toBe(true);
    expect(JSON.parse(objects.get(accountDeletionKey(SUB))!)).toEqual({
      v: 1,
      sub: SUB,
      requestedAt: now.toISOString(),
    });
    expect(await readAccountDeletion(store, SUB)).toEqual(out.record);
  });

  it('leaves an existing marker alone', async () => {
    const existing = { v: 1, sub: SUB, requestedAt: '2026-10-01T00:00:00.000Z' };
    const { store, puts } = memoryStore({ [accountDeletionKey(SUB)]: JSON.stringify(existing) });
    expect(await requestAccountDeletion(store, SUB, now)).toEqual({
      created: false,
      record: existing,
    });
    expect(puts).toEqual([]);
  });

  it('refuses to write when R2 gives no clear answer', async () => {
    const { store, puts } = memoryStore();
    store.head = async () => ({ ok: false, status: 503, etag: null });
    await expect(requestAccountDeletion(store, SUB, now)).rejects.toThrow(/503/);
    expect(puts).toEqual([]);
  });
});

describe('describeAccountDeletion', () => {
  it('says where the deletion is', () => {
    expect(describeAccountDeletion(null)).toMatch(/no deletion requested/);
    const requested = { v: 1 as const, sub: SUB, requestedAt: '2026-10-01T00:00:00.000Z' };
    expect(describeAccountDeletion(requested)).toMatch(/next daily sweep/);
    expect(
      describeAccountDeletion({ ...requested, completedAt: '2026-10-02T03:17:00.000Z' }),
    ).toMatch(/^deleted 2026-10-02/);
  });
});

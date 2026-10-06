import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES } from './api/upload.js';
import {
  clearForeignPendingUpload,
  clearPendingUpload,
  PENDING_UPLOAD_MAX_AGE_MS,
  stashPendingUpload,
  takePendingUpload,
} from './pending-upload.js';

type Handler = (() => void) | null;

/** Just enough of IndexedDB for one keyed store: open, one-store transactions, put/get/delete. */
function fakeIdb(opts: { failOpen?: boolean; failTx?: boolean } = {}) {
  const dbs = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  let opens = 0;

  const factory = {
    open(name: string) {
      opens += 1;
      const req: Record<string, unknown> & { onsuccess: Handler; onerror: Handler } = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
        result: undefined,
        error: null,
      };
      later(() => {
        if (opts.failOpen) {
          req.error = new Error('open failed');
          req.onerror?.();
          return;
        }
        const isNew = !dbs.has(name);
        const stores = dbs.get(name) ?? new Map<string, Map<IDBValidKey, unknown>>();
        dbs.set(name, stores);
        req.result = {
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore: (s: string) => stores.set(s, new Map()),
          close: () => {},
          transaction: (s: string) => {
            const data = stores.get(s)!;
            const tx: Record<string, unknown> & {
              oncomplete: Handler;
              onerror: Handler;
              onabort: Handler;
            } = { oncomplete: null, onerror: null, onabort: null, error: null };
            tx.objectStore = () => ({
              put: (v: unknown, k: IDBValidKey) => data.set(k, v),
              get: (k: IDBValidKey) => {
                const req: { result: unknown; onsuccess: Handler } = {
                  result: data.get(k),
                  onsuccess: null,
                };
                queueMicrotask(() => req.onsuccess?.());
                return req;
              },
              delete: (k: IDBValidKey) => data.delete(k),
            });
            later(() => {
              if (opts.failTx) {
                tx.error = new Error('quota');
                tx.onabort?.();
              } else tx.oncomplete?.();
            });
            return tx;
          },
        };
        if (isNew) (req.onupgradeneeded as Handler)?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return {
    indexedDB: factory as unknown as IDBFactory,
    stored: () => dbs.get('panote')?.get('pending-upload')?.get('upload'),
    opens: () => opens,
  };
}

const jpeg = (name = 'pano.jpg') => new File(['jpeg-bytes'], name, { type: 'image/jpeg' });

describe('pending upload', () => {
  it('stashes a file and takes it back once', async () => {
    const idb = fakeIdb();
    let now = 1_000;
    const opts = { indexedDB: idb.indexedDB, now: () => now };

    expect(await stashPendingUpload(jpeg(), opts)).toBe(true);
    expect(idb.stored()).toMatchObject({ name: 'pano.jpg', type: 'image/jpeg', savedAt: 1_000 });

    now += 60_000;
    const file = await takePendingUpload(opts);
    expect(file?.name).toBe('pano.jpg');
    expect(file?.type).toBe('image/jpeg');
    expect(await file?.text()).toBe('jpeg-bytes');
    expect(idb.stored()).toBeUndefined();
    expect(await takePendingUpload(opts)).toBeNull();
  });

  it('ties an admin stash to its user: anyone else gets nothing and the stash is dropped', async () => {
    const idb = fakeIdb();
    await stashPendingUpload(jpeg(), { indexedDB: idb.indexedDB, owner: 'user-a' });
    expect(idb.stored()).toMatchObject({ owner: 'user-a' });
    expect(await takePendingUpload({ indexedDB: idb.indexedDB, owner: 'user-b' })).toBeNull();
    expect(idb.stored()).toBeUndefined();

    await stashPendingUpload(jpeg(), { indexedDB: idb.indexedDB, owner: 'user-a' });
    expect(await takePendingUpload({ indexedDB: idb.indexedDB })).toBeNull();
    await stashPendingUpload(jpeg(), { indexedDB: idb.indexedDB, owner: 'user-a' });
    expect((await takePendingUpload({ indexedDB: idb.indexedDB, owner: 'user-a' }))?.name).toBe(
      'pano.jpg',
    );
  });

  it('an unowned (landing page) stash goes to whoever signs in', async () => {
    const idb = fakeIdb();
    await stashPendingUpload(jpeg(), { indexedDB: idb.indexedDB });
    expect(idb.stored()).not.toHaveProperty('owner');
    expect((await takePendingUpload({ indexedDB: idb.indexedDB, owner: 'user-b' }))?.name).toBe(
      'pano.jpg',
    );
  });

  it('clearPendingUpload drops the stash and never throws', async () => {
    const idb = fakeIdb();
    await stashPendingUpload(jpeg(), { indexedDB: idb.indexedDB });
    await clearPendingUpload({ indexedDB: idb.indexedDB });
    expect(idb.stored()).toBeUndefined();
    await expect(
      clearPendingUpload({ indexedDB: fakeIdb({ failOpen: true }).indexedDB }),
    ).resolves.toBeUndefined();
    await expect(clearPendingUpload({})).resolves.toBeUndefined();
  });

  it('rebuilds a File when the browser hands back a plain Blob', async () => {
    const idb = fakeIdb();
    await stashPendingUpload(jpeg('hall.jpg'), { indexedDB: idb.indexedDB });
    const record = idb.stored() as { file: Blob };
    record.file = new Blob([await record.file.arrayBuffer()], { type: 'image/jpeg' });
    const file = await takePendingUpload({ indexedDB: idb.indexedDB });
    expect(file).toBeInstanceOf(File);
    expect(file?.name).toBe('hall.jpg');
  });

  it('drops a stash older than 30 minutes', async () => {
    const idb = fakeIdb();
    let now = 0;
    const opts = { indexedDB: idb.indexedDB, now: () => now };
    await stashPendingUpload(jpeg(), opts);
    now = PENDING_UPLOAD_MAX_AGE_MS + 1;
    expect(await takePendingUpload(opts)).toBeNull();
    expect(idb.stored()).toBeUndefined();
  });

  it('only stashes files that pass the upload checks', async () => {
    const idb = fakeIdb();
    const opts = { indexedDB: idb.indexedDB };
    expect(await stashPendingUpload(new File(['x'], 'a.gif', { type: 'image/gif' }), opts)).toBe(
      false,
    );
    expect(await stashPendingUpload(new File([], 'empty.jpg', { type: 'image/jpeg' }), opts)).toBe(
      false,
    );
    const huge = jpeg('huge.jpg');
    Object.defineProperty(huge, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    expect(await stashPendingUpload(huge, opts)).toBe(false);
    expect(idb.opens()).toBe(0);
  });

  it('never throws when IndexedDB is missing or fails', async () => {
    expect(await stashPendingUpload(jpeg())).toBe(false);
    expect(await takePendingUpload()).toBeNull();

    for (const failure of [{ failOpen: true }, { failTx: true }]) {
      const { indexedDB } = fakeIdb(failure);
      expect(await stashPendingUpload(jpeg(), { indexedDB })).toBe(false);
      expect(await takePendingUpload({ indexedDB })).toBeNull();
    }
  });

  it('clearForeignPendingUpload drops only a stash the signed-in user can never take', async () => {
    const idb = fakeIdb();
    let now = 0;
    const opts = { indexedDB: idb.indexedDB, now: () => now };

    await stashPendingUpload(jpeg(), { ...opts, owner: 'user-a' });
    expect(await clearForeignPendingUpload({ ...opts, owner: 'user-a' })).toBe(false);
    expect(idb.stored()).toMatchObject({ owner: 'user-a' });
    expect(await clearForeignPendingUpload({ ...opts, owner: 'user-b' })).toBe(true);
    expect(idb.stored()).toBeUndefined();

    // The landing page's unowned stash is anyone's, until it expires.
    await stashPendingUpload(jpeg(), opts);
    expect(await clearForeignPendingUpload({ ...opts, owner: 'user-b' })).toBe(false);
    expect(idb.stored()).toBeDefined();
    now = PENDING_UPLOAD_MAX_AGE_MS + 1;
    expect(await clearForeignPendingUpload({ ...opts, owner: 'user-b' })).toBe(true);
    expect(idb.stored()).toBeUndefined();

    expect(await clearForeignPendingUpload({ ...opts, owner: 'user-b' })).toBe(false);
    await expect(
      clearForeignPendingUpload({ indexedDB: fakeIdb({ failTx: true }).indexedDB, owner: 'x' }),
    ).resolves.toBe(false);
  });
});

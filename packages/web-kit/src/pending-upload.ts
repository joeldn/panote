import { validateUploadFile } from './api/upload.js';

// The website and admin app share an origin, so a file dropped on the landing
// survives the sign-in redirect here and the admin upload picks it up (Q1).
const DB_NAME = 'panote';
const STORE = 'pending-upload';
const KEY = 'upload';
export const PENDING_UPLOAD_MAX_AGE_MS = 30 * 60 * 1000;

interface PendingRecord {
  file: Blob;
  name: string;
  type: string;
  savedAt: number;
  /** The signed-in user's `sub` when the admin app stashed it; absent from the landing page. */
  owner?: string;
}

export interface PendingUploadOptions {
  /** Defaults to the global `indexedDB`; a test seam. */
  indexedDB?: IDBFactory;
  now?: () => number;
  /**
   * stash: records whose user this is. take: the user taking it; a stash owned by
   * someone else is dropped unused. An unowned (landing) stash goes to anyone.
   */
  owner?: string;
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
}

/** Runs `fn` in one readwrite transaction and resolves once it commits. */
async function inStore<T>(idb: IDBFactory, fn: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await openDb(idb);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result());
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

const globalIdb = (): IDBFactory | undefined =>
  typeof indexedDB === 'undefined' ? undefined : indexedDB;

/**
 * Keeps a dropped file until after sign-in. Only files that pass the upload
 * pre-checks are kept. Resolves false if it wasn't stored; never throws.
 */
export async function stashPendingUpload(
  file: File,
  opts: PendingUploadOptions = {},
): Promise<boolean> {
  const idb = opts.indexedDB ?? globalIdb();
  if (!idb || validateUploadFile(file)) return false;
  const record: PendingRecord = {
    file,
    name: file.name,
    type: file.type,
    savedAt: (opts.now ?? Date.now)(),
  };
  if (opts.owner !== undefined) record.owner = opts.owner;
  try {
    return await inStore(idb, (store) => {
      store.put(record, KEY);
      return () => true;
    });
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is PendingRecord =>
  typeof v === 'object' &&
  v !== null &&
  (v as PendingRecord).file instanceof Blob &&
  typeof (v as PendingRecord).name === 'string' &&
  typeof (v as PendingRecord).type === 'string' &&
  typeof (v as PendingRecord).savedAt === 'number';

/**
 * Reads and deletes the stashed file in one transaction. Null if there is none,
 * it is older than 30 minutes, or IndexedDB fails.
 */
export async function takePendingUpload(opts: PendingUploadOptions = {}): Promise<File | null> {
  const idb = opts.indexedDB ?? globalIdb();
  if (!idb) return null;
  try {
    const value = await inStore(idb, (store) => {
      const get = store.get(KEY);
      store.delete(KEY);
      return () => get.result as unknown;
    });
    if (!isRecord(value)) return null;
    if (value.owner !== undefined && value.owner !== opts.owner) return null;
    const age = (opts.now ?? Date.now)() - value.savedAt;
    if (age < 0 || age > PENDING_UPLOAD_MAX_AGE_MS) return null;
    return value.file instanceof File
      ? value.file
      : new File([value.file], value.name, { type: value.type });
  } catch {
    return null;
  }
}

/** Drops any stashed file (the user gave up on it). Never throws. */
export async function clearPendingUpload(opts: PendingUploadOptions = {}): Promise<void> {
  const idb = opts.indexedDB ?? globalIdb();
  if (!idb) return;
  try {
    await inStore(idb, (store) => {
      store.delete(KEY);
      return () => undefined;
    });
  } catch {
    // Nothing to clear, or IndexedDB is unavailable.
  }
}

/**
 * Drops a stash that `owner` can never take: another user's, or an expired one.
 * The landing page's unowned stash stays. Resolves true if one was dropped; never throws.
 */
export async function clearForeignPendingUpload(
  opts: PendingUploadOptions & { owner: string },
): Promise<boolean> {
  const idb = opts.indexedDB ?? globalIdb();
  if (!idb) return false;
  const now = (opts.now ?? Date.now)();
  try {
    return await inStore(idb, (store) => {
      let dropped = false;
      const get = store.get(KEY);
      get.onsuccess = () => {
        const value = get.result as unknown;
        if (value === undefined) return;
        const age = isRecord(value) ? now - value.savedAt : -1;
        const foreign = isRecord(value) && value.owner !== undefined && value.owner !== opts.owner;
        if (!isRecord(value) || foreign || age < 0 || age > PENDING_UPLOAD_MAX_AGE_MS) {
          store.delete(KEY);
          dropped = true;
        }
      };
      return () => dropped;
    });
  } catch {
    return false;
  }
}

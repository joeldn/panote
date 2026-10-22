import { describe, expect, it } from 'vitest';
import { tileGcKey, TileGcRecordSchema } from '@internal/contracts';
import { recordSupersededVersions, type SupersededStore } from './superseded.js';

const PANO = 'pano-1';
const ORIGINAL = `panos/owner/${PANO}/original`;
const NOW = new Date('2026-10-01T00:00:00.000Z');

/** listPrefixes over a fixed set of dirs; puts into a Map. */
const memoryStore = (dirs: string[], existing: string[] = []) => {
  const objects = new Map<string, string>(existing.map((k) => [k, 'earlier']));
  const store: SupersededStore = {
    async listPrefixes(prefix) {
      return dirs.map((d) => `${prefix}${d}/`);
    },
    async put(key, body) {
      objects.set(key, String(body));
    },
  };
  return { store, objects };
};

const run = (store: SupersededStore, current = 't1-new') =>
  recordSupersededVersions(store, {
    panoId: PANO,
    current,
    originalKey: ORIGINAL,
    tilerVersion: 1,
    now: NOW,
  });

describe('recordSupersededVersions', () => {
  it('records every version dir but the current one, never the current one', async () => {
    const { store, objects } = memoryStore(['t1-old', 't1-new', 't0-older']);
    expect(await run(store)).toEqual(['t1-old', 't0-older']);
    expect([...objects.keys()].sort()).toEqual(
      [tileGcKey(PANO, 't0-older'), tileGcKey(PANO, 't1-old')].sort(),
    );
    const record = TileGcRecordSchema.parse(JSON.parse(objects.get(tileGcKey(PANO, 't1-old'))!));
    expect(record).toEqual({
      v: 1,
      originalKey: ORIGINAL,
      tilerVersion: 1,
      supersededAt: NOW.toISOString(),
    });
  });

  it('writes nothing for a first tiling, where the current version is the only dir', async () => {
    const { store, objects } = memoryStore(['t1-new']);
    expect(await run(store)).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it('overwrites an existing record, so its time follows the latest swap', async () => {
    const { store, objects } = memoryStore(['t1-old', 't1-new'], [tileGcKey(PANO, 't1-old')]);
    expect(await run(store)).toEqual(['t1-old']);
    expect(JSON.parse(objects.get(tileGcKey(PANO, 't1-old'))!)).toMatchObject({
      supersededAt: NOW.toISOString(),
    });
  });

  it('drops a listed dir whose name is not a valid version', async () => {
    const { store } = memoryStore(['t1-old', 'bad.name']);
    expect(await run(store)).toEqual(['t1-old']);
  });

  it('throws any other put error, for the caller to log', async () => {
    const { store } = memoryStore(['t1-old']);
    store.put = async () => {
      throw new Error('R2 PUT -> 500');
    };
    await expect(run(store)).rejects.toThrow('500');
  });
});

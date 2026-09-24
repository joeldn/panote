import {
  configKey,
  deletingKey,
  manifestKey,
  originalKey,
  panoPrefix,
  tilesPrefix,
  tileVersionPrefix,
} from '@internal/contracts';
import { describe, expect, it } from 'vitest';
import { deletePano } from './delete-pano.js';

const SUB = 'auth0|me';
const PANO = 'p1';

/** Records every call in order; can fault a delete under a prefix or insert
 * a key right after one, without a real R2 binding. */
class RecordingBucket {
  readonly calls: string[] = [];
  private readonly store: Set<string>;
  private throwOnDeletePrefix: string | undefined;
  private lateWrite: { afterKey: string; key: string } | undefined;

  constructor(initialKeys: string[]) {
    this.store = new Set(initialKeys);
  }

  failDeletesUnder(prefix: string): void {
    this.throwOnDeletePrefix = prefix;
  }

  clearFault(): void {
    this.throwOnDeletePrefix = undefined;
  }

  /** Simulates a job's late write landing right after `afterKey` is deleted. */
  writeLateAfterDeleting(afterKey: string, key: string): void {
    this.lateWrite = { afterKey, key };
  }

  async head(key: string) {
    this.calls.push(`head:${key}`);
    return this.store.has(key) ? ({ key } as unknown as R2Object) : null;
  }

  async put(key: string, _value: unknown) {
    this.calls.push(`put:${key}`);
    this.store.add(key);
    return { key } as unknown as R2Object;
  }

  async list(options?: R2ListOptions) {
    const prefix = options?.prefix ?? '';
    this.calls.push(`list:${prefix}`);
    const objects = [...this.store]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }) as unknown as R2Object);
    return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
  }

  async delete(keys: string | string[]) {
    const arr = Array.isArray(keys) ? keys : [keys];
    this.calls.push(`delete:${arr.join(',')}`);
    const matches = (p: string): boolean => arr.some((k) => k.startsWith(p));
    if (this.throwOnDeletePrefix && matches(this.throwOnDeletePrefix)) {
      throw new Error(`fault: delete under ${this.throwOnDeletePrefix}`);
    }
    for (const k of arr) this.store.delete(k);
    if (this.lateWrite && arr.includes(this.lateWrite.afterKey)) {
      const { key } = this.lateWrite;
      this.lateWrite = undefined;
      this.store.add(key);
    }
  }
}

const seededBucket = (): RecordingBucket =>
  new RecordingBucket([
    originalKey(SUB, PANO),
    configKey(SUB, PANO),
    tileVersionPrefix(PANO, 't1-abc') + '0/px/0-0.webp',
  ]);

describe('deletePano', () => {
  it('with proof, deletes in order: tombstone -> original -> tiles sweep -> rest of prefix -> tombstone last', async () => {
    const bucket = seededBucket();

    const result = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);

    expect(result).toEqual({ ok: true });
    expect(bucket.calls).toEqual([
      `head:${originalKey(SUB, PANO)}`,
      `head:${deletingKey(SUB, PANO)}`,
      `put:${deletingKey(SUB, PANO)}`,
      `delete:${originalKey(SUB, PANO)}`,
      `list:${tilesPrefix(PANO)}`,
      `delete:${tileVersionPrefix(PANO, 't1-abc') + '0/px/0-0.webp'}`,
      `list:${panoPrefix(SUB, PANO)}`,
      `delete:${configKey(SUB, PANO)},${deletingKey(SUB, PANO)}`,
    ]);
  });

  it('a late write landing right after the original is deleted is removed by the one tiles sweep', async () => {
    const bucket = seededBucket();
    const lateKey = manifestKey(PANO);
    bucket.writeLateAfterDeleting(originalKey(SUB, PANO), lateKey);

    const result = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);

    expect(result).toEqual({ ok: true });
    expect(await bucket.head(lateKey)).toBeNull();
  });

  it('with no proof (no original, no tombstone), deletes only the caller-owned prefix and leaves tiles/ untouched', async () => {
    const bucket = new RecordingBucket([
      configKey(SUB, PANO),
      tileVersionPrefix(PANO, 't1-abc') + '0/px/0-0.webp',
    ]);

    const result = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);

    expect(result).toEqual({ ok: true });
    expect(bucket.calls).toEqual([
      `head:${originalKey(SUB, PANO)}`,
      `head:${deletingKey(SUB, PANO)}`,
      `list:${panoPrefix(SUB, PANO)}`,
      `delete:${configKey(SUB, PANO)}`,
    ]);
    expect(await bucket.head(tileVersionPrefix(PANO, 't1-abc') + '0/px/0-0.webp')).not.toBeNull();
  });

  it('a fault in the tiles sweep leaves the (already-deleted-original) tombstone in place, and a retry resumes', async () => {
    const bucket = seededBucket();
    const lateTile = tileVersionPrefix(PANO, 't1-abc') + 'late.webp';
    bucket.writeLateAfterDeleting(originalKey(SUB, PANO), lateTile);
    bucket.failDeletesUnder(tilesPrefix(PANO));

    await expect(deletePano(bucket as unknown as R2Bucket, SUB, PANO)).rejects.toThrow(
      /fault: delete under/,
    );

    expect(await bucket.head(originalKey(SUB, PANO))).toBeNull();
    expect(await bucket.head(deletingKey(SUB, PANO))).not.toBeNull();

    // Retry: the fault is gone, the tombstone is the only proof left.
    bucket.clearFault();
    const retry = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);
    expect(retry).toEqual({ ok: true });
    expect(await bucket.head(lateTile)).toBeNull();
    expect(await bucket.head(deletingKey(SUB, PANO))).toBeNull();
  });

  it('a fault in the final prefix delete leaves the tombstone in place, and a retry finishes the delete', async () => {
    const bucket = seededBucket();
    // configKey is only ever deleted by the final prefix delete, so this
    // isolates that step's fault from the earlier original/tiles deletes.
    bucket.failDeletesUnder(configKey(SUB, PANO));

    await expect(deletePano(bucket as unknown as R2Bucket, SUB, PANO)).rejects.toThrow(
      /fault: delete under/,
    );

    expect(await bucket.head(originalKey(SUB, PANO))).toBeNull();
    expect(await bucket.head(deletingKey(SUB, PANO))).not.toBeNull();

    bucket.clearFault();
    const retry = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);
    expect(retry).toEqual({ ok: true });
    expect(await bucket.head(configKey(SUB, PANO))).toBeNull();
    expect(await bucket.head(deletingKey(SUB, PANO))).toBeNull();
  });

  it('resumes from a leftover tombstone when the original is already gone: deletes a late tile and the tombstone', async () => {
    const lateTile = tileVersionPrefix(PANO, 't1-abc') + '0/px/0-0.webp';
    const bucket = new RecordingBucket([deletingKey(SUB, PANO), lateTile]);

    const result = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);

    expect(result).toEqual({ ok: true });
    expect(await bucket.head(lateTile)).toBeNull();
    expect(await bucket.head(deletingKey(SUB, PANO))).toBeNull();
    // No tombstone put - one was already there.
    expect(bucket.calls).not.toContain(`put:${deletingKey(SUB, PANO)}`);
  });

  it('a repeat delete of an already-fully-deleted pano is idempotent', async () => {
    const bucket = new RecordingBucket([]);

    const result = await deletePano(bucket as unknown as R2Bucket, SUB, PANO);

    expect(result).toEqual({ ok: true });
  });
});

import { PANO_PATTERN, tileGcKey, tilesPrefix, type TileGcRecord } from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

export type SupersededStore = Pick<R2S3Client, 'listPrefixes' | 'put'>;

/**
 * After a confirmed manifest swap, records every other version dir under
 * tiles/<panoId>/ for admin-api's daily sweep (services/admin-api/src/tile-gc.ts),
 * which deletes them after a grace period. This never deletes anything itself: a
 * viewer that loaded the old manifest a moment ago may still be fetching its
 * tiles, and a dir listed here can belong to a newer job still uploading. The
 * sweep re-checks both before it deletes.
 *
 * A plain overwrite, so supersededAt and tilerVersion always follow the latest
 * swap: a dir that was live again in between (a re-upload of old bytes, a tiler
 * rollback) gets a fresh grace period instead of an old record's. Returns the
 * versions it recorded.
 */
export const recordSupersededVersions = async (
  store: SupersededStore,
  params: {
    panoId: string;
    current: string;
    originalKey: string;
    tilerVersion: number;
    now: Date;
  },
): Promise<string[]> => {
  const { panoId, current, originalKey, tilerVersion, now } = params;
  const prefix = tilesPrefix(panoId);
  const versions = (await store.listPrefixes(prefix))
    .filter((p) => p.startsWith(prefix) && p.endsWith('/'))
    .map((p) => p.slice(prefix.length, -1))
    .filter((v) => v !== current && PANO_PATTERN.test(v));
  const record: TileGcRecord = {
    v: 1,
    originalKey,
    tilerVersion,
    supersededAt: now.toISOString(),
  };
  const recorded: string[] = [];
  for (const v of versions) {
    await store.put(tileGcKey(panoId, v), JSON.stringify(record), {
      contentType: 'application/json',
    });
    recorded.push(v);
  }
  return recorded;
};

/**
 * Records `version`, the dir a failed job was writing, for the same sweep. The
 * sweep keeps it while the pano's original still tiles into it, so a retry is
 * never cut short, and deletes it after the grace period once the original has
 * changed or gone. A later successful swap would record it too; this covers a
 * pano that never tiles again. Same record shape, overwritten on every attempt.
 */
export const recordFailedVersion = async (
  store: Pick<SupersededStore, 'put'>,
  params: {
    panoId: string;
    version: string;
    originalKey: string;
    tilerVersion: number;
    now: Date;
  },
): Promise<void> => {
  const { panoId, version, originalKey, tilerVersion, now } = params;
  const record: TileGcRecord = {
    v: 1,
    originalKey,
    tilerVersion,
    supersededAt: now.toISOString(),
  };
  await store.put(tileGcKey(panoId, version), JSON.stringify(record), {
    contentType: 'application/json',
  });
};

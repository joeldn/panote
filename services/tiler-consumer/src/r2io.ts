export type PutFn = (key: string, body: Uint8Array, contentType: string) => Promise<void>;

// Tile PUTs in flight at once. Bodies are already in memory (walk()), so this
// adds only sockets and request state, well inside standard-4's 12 GiB.
export const UPLOAD_CONCURRENCY = 16;

const ctOf = (k: string): string =>
  k.endsWith('.json')
    ? 'application/json'
    : k.endsWith('.webp')
      ? 'image/webp'
      : 'application/octet-stream';

/** Uploads every tile (all keys but manifest.json) under `tilePrefix`, `concurrency` at a time.
 *  Resolves after all succeed; on a failure, drains in-flight PUTs and rejects with the first error. */
export const uploadDir = async (
  files: Record<string, Uint8Array>,
  tilePrefix: string,
  put: PutFn,
  concurrency: number = UPLOAD_CONCURRENCY,
): Promise<void> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`uploadDir concurrency must be a positive integer (got ${concurrency})`);
  }
  const tiles = Object.keys(files).filter((k) => k !== 'manifest.json');
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < tiles.length) {
      const k = tiles[next++]!;
      try {
        await put(tilePrefix + k, files[k]!, ctOf(k));
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
  if (failure) throw failure.error;
};

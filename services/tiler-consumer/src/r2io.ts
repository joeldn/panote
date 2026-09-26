export type PutFn = (key: string, body: Uint8Array, contentType: string) => Promise<void>;

const ctOf = (k: string): string =>
  k.endsWith('.json')
    ? 'application/json'
    : k.endsWith('.webp')
      ? 'image/webp'
      : 'application/octet-stream';

/** Uploads every tile in `files` (all keys except manifest.json) under `tilePrefix`. */
export const uploadDir = async (
  files: Record<string, Uint8Array>,
  tilePrefix: string,
  put: PutFn,
): Promise<void> => {
  const tiles = Object.keys(files).filter((k) => k !== 'manifest.json');
  for (const k of tiles) await put(tilePrefix + k, files[k]!, ctOf(k));
};

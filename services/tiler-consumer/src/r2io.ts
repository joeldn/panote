export type PutFn = (key: string, body: Uint8Array, contentType: string) => Promise<void>;

const ctOf = (k: string): string =>
  k.endsWith('.json')
    ? 'application/json'
    : k.endsWith('.webp')
      ? 'image/webp'
      : 'application/octet-stream';

/** Upload all files; manifest.json is forced LAST so a polling client only
 * sees it once every tile exists (it is the readiness flag). */
export const uploadDir = async (
  files: Record<string, Uint8Array>,
  prefix: string,
  put: PutFn,
): Promise<void> => {
  const keys = Object.keys(files);
  const tiles = keys.filter((k) => k !== 'manifest.json');
  for (const k of tiles) await put(prefix + k, files[k]!, ctOf(k));
  if (files['manifest.json'])
    await put(prefix + 'manifest.json', files['manifest.json'], 'application/json');
};

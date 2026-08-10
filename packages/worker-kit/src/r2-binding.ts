export const getJson = async <T>(
  bucket: R2Bucket,
  key: string,
): Promise<{ value: T; etag: string } | null> => {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return { value: (await obj.json()) as T, etag: obj.etag };
};

/**
 * Write a JSON object under an optional R2 precondition. `onlyIf` maps directly
 * to R2's conditional put:
 *   - `{ etagDoesNotMatch: '*' }` — create-only (fails if the key exists)
 *   - `{ etagMatches: etag }`     — conditional update (fails if changed)
 *   - `undefined`                 — unconditional overwrite
 * A failed precondition returns `{ ok: false, conflict: true }` (R2 puts return
 * null when `onlyIf` does not hold); an unconditional put always succeeds.
 */
export const putJson = async (
  bucket: R2Bucket,
  key: string,
  value: unknown,
  onlyIf?: R2Conditional,
): Promise<{ ok: true; etag: string } | { ok: false; conflict: true }> => {
  const res = await bucket.put(key, JSON.stringify(value), {
    ...(onlyIf ? { onlyIf } : {}),
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=30',
    },
  });
  if (!res) return { ok: false, conflict: true };
  return { ok: true, etag: res.etag };
};

export const listChildren = async (bucket: R2Bucket, prefix: string): Promise<string[]> => {
  const out = new Set<string>();
  let cursor: string | undefined;
  do {
    const r = await bucket.list({ prefix, delimiter: '/', ...(cursor ? { cursor } : {}) });
    for (const p of r.delimitedPrefixes) out.add(p.slice(prefix.length).replace(/\/$/, ''));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return [...out];
};

export const deletePrefix = async (bucket: R2Bucket, prefix: string): Promise<void> => {
  let cursor: string | undefined;
  do {
    const r = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (r.objects.length) await bucket.delete(r.objects.map((o) => o.key));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
};

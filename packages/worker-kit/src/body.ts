export type BodyTextResult = { ok: true; text: string } | { ok: false; status: 413 };
export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/**
 * The request body as text, at most `maxBytes` of it. A Content-Length over the cap is
 * refused before anything is read. A body without one (chunked) is counted as it streams
 * in and the stream is cancelled once it passes the cap, so nothing past the cap is ever
 * held in memory, unlike `req.text()`, which buffers the whole body before any check.
 */
export const readBodyText = async (req: Request, maxBytes: number): Promise<BodyTextResult> => {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return { ok: false, status: 413 };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // The sender may keep going: cancelling tells the runtime to stop reading it.
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
};

/**
 * The body parsed as JSON, read through `readBodyText` whatever the content-type (a
 * `sendBeacon` string arrives as text/plain). An empty body is `{}`; over the cap is a
 * 413, anything that isn't JSON a 400.
 */
export const readJsonBody = async (req: Request, maxBytes: number): Promise<BodyResult> => {
  const body = await readBodyText(req, maxBytes);
  if (!body.ok) return body;
  if (body.text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
};

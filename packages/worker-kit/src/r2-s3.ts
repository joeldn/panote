import { AwsClient } from 'aws4fetch';

export interface R2S3Config {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** aws4fetch's own retry count for `.fetch()` calls (its default is 10). */
  readonly retries?: number | undefined;
}

export interface R2HeadResult {
  readonly ok: boolean;
  readonly status: number;
  /** Raw header value (still double-quoted, as S3 sends it), or null when absent/not ok. */
  readonly etag: string | null;
}

export interface R2S3Client {
  /** Presigned PUT URL. Requires the S3 API - the native R2 binding cannot presign. */
  presignPut(
    key: string,
    opts?: {
      expiresInSeconds?: number | undefined;
      /**
       * Pinned into SignedHeaders: the PUT's header value must match this
       * byte-for-byte (e.g. lowercase `image/png`, no `; charset=...`) or R2 403s.
       */
      headers?: Record<string, string> | undefined;
      /**
       * The body's exact byte length, signed as `content-length`. A browser sends
       * Content-Length itself (a Blob's size), so the PUT must carry exactly this
       * many bytes for the signature to match - if R2 enforces signed
       * content-length on a presigned PUT, which is unverified (docs/deploy.md).
       */
      contentLength?: number | undefined;
    },
  ): Promise<string>;
  /** Raw GET. The caller checks `res.ok` and reads the body it wants. */
  get(key: string): Promise<Response>;
  /**
   * PUT. Throws on a non-2xx response. A thrown network error is retried
   * twice with a short backoff; 4xx responses are never retried. With
   * `ifMatch` (an ETag as `head`/`get` return it), R2 writes only while the
   * object still has that ETag, and a mismatch throws R2PreconditionFailedError.
   * `ifNoneMatch: '*'` makes it create-only, failing the same way.
   */
  put(
    key: string,
    body: Uint8Array | string,
    opts: {
      contentType: string;
      cacheControl?: string | undefined;
      ifMatch?: string | undefined;
      /** `'*'`: create-only, a key that already exists throws R2PreconditionFailedError. */
      ifNoneMatch?: '*' | undefined;
    },
  ): Promise<void>;
  /** Signed HEAD. Never throws on a non-2xx - the caller checks `ok`. */
  head(key: string): Promise<R2HeadResult>;
  /** Signed DELETE. Throws on a non-2xx response. */
  deleteObject(key: string): Promise<void>;
  /**
   * The "folders" directly under `prefix` (ListObjectsV2 with a `/` delimiter),
   * every page of them, each ending in `/`. Throws on a non-2xx response.
   */
  listPrefixes(prefix: string): Promise<string[]>;
  /**
   * Every object under `prefix` (ListObjectsV2, no delimiter), every page of
   * them, with its size in bytes. Throws on a non-2xx response.
   */
  listObjects(prefix: string): Promise<R2ListedObject[]>;
}

export interface R2ListedObject {
  readonly key: string;
  readonly size: number;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};
const unescapeXml = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e] ?? e);

/** A conditional PUT's If-Match no longer matched: someone else wrote the object first. */
export class R2PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`R2 PUT ${key} -> 412`);
    this.name = 'R2PreconditionFailedError';
  }
}

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;

// aws4fetch retries only 5xx/429 responses. A thrown network error
// (ECONNRESET, `fetch failed`) rejects straight through, so `put` - the
// container's hot path, hundreds of PUTs per job - gets its own small retry.
const PUT_NETWORK_RETRIES = 2;
const PUT_NETWORK_RETRY_BASE_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `send`, retrying only when it throws (a network-level failure). A
 * non-2xx response resolves normally and is never retried here.
 */
const retryOnThrow = async <T>(send: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (attempt >= PUT_NETWORK_RETRIES) throw e;
      await sleep(PUT_NETWORK_RETRY_BASE_MS * 2 ** attempt);
    }
  }
};

export const createR2S3Client = (config: R2S3Config): R2S3Client => {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    ...(config.retries === undefined ? {} : { retries: config.retries }),
  });
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;

  // ListObjectsV2, one response body per page, following continuation tokens.
  async function* listPages(prefix: string, delimiter?: string): AsyncGenerator<string> {
    let token: string | undefined;
    do {
      const url = new URL(base);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (delimiter !== undefined) url.searchParams.set('delimiter', delimiter);
      if (token !== undefined) url.searchParams.set('continuation-token', token);
      const res = await aws.fetch(url.toString());
      if (!res.ok) throw new Error(`R2 LIST ${prefix} -> ${res.status}`);
      const xml = await res.text();
      yield xml;
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
      token = truncated && next ? unescapeXml(next) : undefined;
    } while (token !== undefined);
  }

  return {
    async presignPut(key, opts) {
      const expiresInSeconds = opts?.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
      const endpoint = `${base}/${key}?X-Amz-Expires=${expiresInSeconds}`;
      const contentLength = opts?.contentLength;
      if (
        contentLength !== undefined &&
        (!Number.isSafeInteger(contentLength) || contentLength < 0)
      ) {
        throw new Error('contentLength must be a non-negative integer');
      }
      const headers = {
        ...opts?.headers,
        ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) }),
      };
      const pinned = Object.keys(headers).length > 0;
      // allHeaders: aws4fetch excludes content-type and content-length from
      // SignedHeaders by default (it assumes an unknown-at-sign-time streamed body).
      const signed = await aws.sign(endpoint, {
        method: 'PUT',
        ...(pinned ? { headers } : {}),
        aws: { signQuery: true, allHeaders: pinned },
      });
      return signed.url;
    },

    async get(key) {
      return aws.fetch(`${base}/${key}`);
    },

    async head(key) {
      const res = await aws.fetch(`${base}/${key}`, { method: 'HEAD' });
      return { ok: res.ok, status: res.status, etag: res.ok ? res.headers.get('etag') : null };
    },

    async deleteObject(key) {
      const res = await aws.fetch(`${base}/${key}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`R2 DELETE ${key} -> ${res.status}`);
    },

    async listPrefixes(prefix) {
      const found: string[] = [];
      for await (const xml of listPages(prefix, '/')) {
        for (const m of xml.matchAll(
          /<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>\s*<\/CommonPrefixes>/g,
        ))
          found.push(unescapeXml(m[1]!));
      }
      return found;
    },

    async listObjects(prefix) {
      const found: R2ListedObject[] = [];
      for await (const xml of listPages(prefix)) {
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1];
          const size = /<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1];
          if (key !== undefined) found.push({ key: unescapeXml(key), size: Number(size ?? 0) });
        }
      }
      return found;
    },

    async put(key, body, opts) {
      // body is a Uint8Array or string, never a stream, so it is safe to
      // send again on a retry.
      const res = await retryOnThrow(() =>
        aws.fetch(`${base}/${key}`, {
          method: 'PUT',
          body,
          headers: {
            'content-type': opts.contentType,
            ...(opts.cacheControl ? { 'cache-control': opts.cacheControl } : {}),
            ...(opts.ifMatch ? { 'if-match': opts.ifMatch } : {}),
            ...(opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
          },
        }),
      );
      if (res.status === 412) throw new R2PreconditionFailedError(key);
      if (!res.ok) throw new Error(`R2 PUT ${key} -> ${res.status}`);
    },
  };
};

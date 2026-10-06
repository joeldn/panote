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
    },
  ): Promise<string>;
  /** Raw GET. The caller checks `res.ok` and reads the body it wants. */
  get(key: string): Promise<Response>;
  /**
   * PUT. Throws on a non-2xx response. A thrown network error is retried
   * twice with a short backoff; 4xx responses are never retried.
   */
  put(
    key: string,
    body: Uint8Array | string,
    opts: { contentType: string; cacheControl?: string | undefined },
  ): Promise<void>;
  /** Signed HEAD. Never throws on a non-2xx - the caller checks `ok`. */
  head(key: string): Promise<R2HeadResult>;
  /** Signed DELETE. Throws on a non-2xx response. */
  deleteObject(key: string): Promise<void>;
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

  return {
    async presignPut(key, opts) {
      const expiresInSeconds = opts?.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
      const endpoint = `${base}/${key}?X-Amz-Expires=${expiresInSeconds}`;
      // allHeaders: aws4fetch excludes content-type from SignedHeaders by
      // default (it assumes an unknown-at-sign-time streamed body).
      const signed = await aws.sign(endpoint, {
        method: 'PUT',
        ...(opts?.headers ? { headers: opts.headers } : {}),
        aws: { signQuery: true, allHeaders: Boolean(opts?.headers) },
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
          },
        }),
      );
      if (!res.ok) throw new Error(`R2 PUT ${key} -> ${res.status}`);
    },
  };
};

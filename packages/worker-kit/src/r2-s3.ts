import { AwsClient } from 'aws4fetch';

export interface R2S3Config {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface R2HeadResult {
  readonly ok: boolean;
  readonly status: number;
  /** Raw header value (still double-quoted, as S3 sends it), or null when absent/not ok. */
  readonly etag: string | null;
}

export interface R2S3Client {
  /** Presigned PUT URL. Requires the S3 API - the native R2 binding cannot presign. */
  presignPut(key: string, opts?: { expiresInSeconds?: number | undefined }): Promise<string>;
  /** Raw GET. The caller checks `res.ok` and reads the body it wants. */
  get(key: string): Promise<Response>;
  /** PUT. Throws on a non-2xx response. */
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

export const createR2S3Client = (config: R2S3Config): R2S3Client => {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;

  return {
    async presignPut(key, opts) {
      const expiresInSeconds = opts?.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
      const endpoint = `${base}/${key}?X-Amz-Expires=${expiresInSeconds}`;
      const signed = await aws.sign(endpoint, {
        method: 'PUT',
        aws: { signQuery: true },
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
      const res = await aws.fetch(`${base}/${key}`, {
        method: 'PUT',
        body,
        headers: {
          'content-type': opts.contentType,
          ...(opts.cacheControl ? { 'cache-control': opts.cacheControl } : {}),
        },
      });
      if (!res.ok) throw new Error(`R2 PUT ${key} -> ${res.status}`);
    },
  };
};

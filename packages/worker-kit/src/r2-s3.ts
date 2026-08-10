import { AwsClient } from 'aws4fetch';

export interface R2S3Config {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
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

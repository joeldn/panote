import { describe, expect, it } from 'vitest';
import { originalKey } from '@internal/contracts';

import { createR2S3Client } from './r2-s3.js';

// Pins that the S3 API and the native R2 binding land on the same key: the
// S3 path is percent-decoded before the object is stored, while the
// binding key is literal, so a "%" in a key segment would diverge between
// the two.
describe('R2 key parity between the S3 API and the native R2 binding', () => {
  it('the S3 presigned URL, once its path is percent-decoded, writes to the exact key string the native binding uses', async () => {
    const config = {
      accountId: 'acct123',
      bucket: 'mybucket',
      accessKeyId: 'test-access-key-id',
      secretAccessKey: 'test-secret-access-key',
    };
    // The case that matters most: an Auth0 sub contains "|".
    const sub = 'auth0|me';
    const panoId = 'p1';

    // What the native R2 binding (admin-api, via r2-binding.ts) uses
    // verbatim as the object key.
    const bindingKey = originalKey(sub, panoId);

    // What upload-api's presigned PUT actually writes the object under:
    // the URL path an S3-compatible server percent-decodes before storing.
    const client = createR2S3Client(config);
    const url = await client.presignPut(bindingKey);
    const pathname = new URL(url).pathname;
    const bucketPrefix = `/${config.bucket}/`;
    expect(pathname.startsWith(bucketPrefix)).toBe(true);
    const s3StoredKey = decodeURIComponent(pathname.slice(bucketPrefix.length));

    // Both access paths must resolve to the exact same physical R2 object.
    expect(s3StoredKey).toBe(bindingKey);
  });
});

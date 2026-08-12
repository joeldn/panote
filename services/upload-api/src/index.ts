import { originalKey } from '@internal/contracts';
import { authenticate, toErrorResponse } from '@internal/worker-kit';
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/api/upload-url') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    try {
      const { sub } = await authenticate(req, env);
      const panoId = crypto.randomUUID();
      const key = originalKey(sub, panoId);
      const r2 = createR2S3Client({
        accountId: env.R2_ACCOUNT_ID,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });
      return Response.json({ panoId, key, url: await r2.presignPut(key) });
    } catch (e) {
      return toErrorResponse(e);
    }
  },
};

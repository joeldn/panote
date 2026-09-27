import type { AdminApi } from './api/admin.js';
import type { FetchLike } from './api/http.js';
import { fetchManifest } from './api/public.js';
import { putFile, type UploadApi, type UploadContentType, type XhrLike } from './api/upload.js';
import type { UploadDeps } from './upload-machine.js';

export interface UploadDepsOptions {
  uploadApi: UploadApi;
  adminApi: Pick<AdminApi, 'getPanoStatus'>;
  /** The viewer's tiles base, `tilesBaseUrl(config)`. */
  tilesBase: string;
  fetch?: FetchLike;
  createXhr?: () => XhrLike;
}

/** Wire the upload machine to the real presign route, XHR PUT, CDN and status route. */
export function createUploadDeps(opts: UploadDepsOptions): UploadDeps {
  return {
    presign: (req) =>
      opts.uploadApi.presign({ ...req, contentType: req.contentType as UploadContentType }),
    put: (url, file, o) => {
      const putOpts: Parameters<typeof putFile>[2] = {
        contentType: o.contentType,
        onProgress: o.onProgress,
        signal: o.signal,
      };
      if (opts.createXhr) putOpts.createXhr = opts.createXhr;
      return putFile(url, file, putOpts);
    },
    fetchManifest: (panoId, o) => {
      const fo: Parameters<typeof fetchManifest>[2] = { signal: o.signal };
      if (opts.fetch) fo.fetch = opts.fetch;
      return fetchManifest(opts.tilesBase, panoId, fo);
    },
    getPanoStatus: (panoId) => opts.adminApi.getPanoStatus(panoId),
  };
}

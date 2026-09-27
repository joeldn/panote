import { PANO_PATTERN } from '@internal/contracts';
import { z } from 'zod';

import { ApiError, parseWith, readJson, type FetchLike, type TokenGetter } from './http.js';

/** Must match services/upload-api (MAX_ORIGINAL_BYTES, ALLOWED_CONTENT_TYPES). */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

export const UploadUrlOkSchema = z.object({
  panoId: z.string().regex(PANO_PATTERN),
  key: z.string().min(1),
  url: z.string().url(),
});
export type UploadUrlOk = z.infer<typeof UploadUrlOkSchema>;

export interface PresignRequest {
  contentType: UploadContentType;
  size: number;
  /** Set to replace an existing pano's image (re-tiles in place). */
  panoId?: string;
}

export interface UploadApiOptions {
  getToken: TokenGetter;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface UploadApi {
  presign(req: PresignRequest): Promise<UploadUrlOk>;
}

export function createUploadApi(opts: UploadApiOptions): UploadApi {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async presign(req) {
      const url = `${base}/api/upload-url`;
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await opts.getToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
      const body = await readJson(res);
      if (!res.ok) throw new ApiError(res.status, body);
      const ok = parseWith(UploadUrlOkSchema, url, body);
      if (req.panoId !== undefined && ok.panoId !== req.panoId) {
        throw new ApiError(res.status, body, 'presign returned a different panoId');
      }
      return ok;
    },
  };
}

/** The slice of XMLHttpRequest the uploader uses; injectable for tests. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  upload: {
    onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
}

export class UploadAbortedError extends Error {
  constructor() {
    super('upload aborted');
    this.name = 'UploadAbortedError';
  }
}

export interface PutFileOptions {
  contentType: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  createXhr?: () => XhrLike;
}

/**
 * PUT a file to a presigned URL with XMLHttpRequest, since fetch has no upload
 * progress. Resolves on 2xx; the ETag is not readable cross-origin.
 */
export function putFile(url: string, file: Blob, opts: PutFileOptions): Promise<void> {
  const xhr = opts.createXhr?.() ?? (new XMLHttpRequest() as unknown as XhrLike);
  return new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }
    const onAbortSignal = () => xhr.abort();
    opts.signal?.addEventListener('abort', onAbortSignal, { once: true });
    const done = (fn: () => void) => {
      opts.signal?.removeEventListener('abort', onAbortSignal);
      fn();
    };
    xhr.open('PUT', url);
    // Signed into the presign (upload-api), so it must match exactly.
    xhr.setRequestHeader('Content-Type', opts.contentType);
    xhr.upload.onprogress = (e) => {
      opts.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
    };
    xhr.onload = () =>
      done(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          opts.onProgress?.(file.size, file.size);
          resolve();
        } else {
          reject(new ApiError(xhr.status, null, `upload failed with ${xhr.status}`));
        }
      });
    xhr.onerror = () => done(() => reject(new ApiError(0, null, 'upload network error')));
    xhr.ontimeout = () => done(() => reject(new ApiError(0, null, 'upload timed out')));
    xhr.onabort = () => done(() => reject(new UploadAbortedError()));
    xhr.send(file);
  });
}

export type UploadValidationError =
  | { code: 'type'; message: string }
  | { code: 'size'; message: string }
  | { code: 'empty'; message: string };

/** Cheap pre-checks before asking for a presign (type and byte size). */
export function validateUploadFile(file: {
  type: string;
  size: number;
}): UploadValidationError | null {
  if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return { code: 'type', message: 'Use a JPG, PNG or WebP image.' };
  }
  if (file.size <= 0) return { code: 'empty', message: 'This file is empty.' };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { code: 'size', message: 'This file is larger than 150 MB.' };
  }
  return null;
}

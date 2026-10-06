import { closePreview, type DecodedPreview } from './decode.js';
import {
  readDeviceHints,
  selectPreviewTier,
  type PreviewLimits,
  type PreviewTier,
} from './plan.js';
import type { DecodeMessage, DecodeResponse } from './protocol.js';

/** Just enough of `Worker` for `decodePreview`. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface DecodePreviewOptions extends PreviewLimits {
  signal?: AbortSignal | undefined;
  /** Defaults to the tier the device hints pick. */
  tier?: PreviewTier | undefined;
  createWorker?: (() => WorkerLike) | undefined;
}

// Literal `new Worker(new URL(...))` so Vite finds and bundles the worker as a same-origin file.
const startWorker = (): WorkerLike =>
  new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'pano-preview' });

/**
 * Decode a picked panorama into a preview off the main thread. Null when this
 * device shouldn't preview it. Aborting kills the worker and frees every bitmap.
 */
export function decodePreview(
  file: Blob,
  options: DecodePreviewOptions = {},
): Promise<DecodedPreview | null> {
  const { signal, createWorker = startWorker } = options;
  if (signal?.aborted) return Promise.reject(signal.reason as Error);
  const tier = options.tier ?? selectPreviewTier(readDeviceHints());

  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const settle = () => {
      settled = true;
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(signal?.reason as Error);
    };

    worker.onmessage = ({ data }) => {
      const response = data as DecodeResponse;
      if (settled) {
        // Landed after an abort: nobody will draw these.
        if (response.type === 'done' && response.result) closePreview(response.result.source);
        return;
      }
      settle();
      if (response.type === 'done') resolve(response.result);
      else reject(new Error(`preview decode failed: ${response.message}`));
    };
    worker.onerror = (event) => {
      if (settled) return;
      settle();
      reject(new Error(`preview worker crashed: ${event.message || 'unknown error'}`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const limits: PreviewLimits = {
      maxTextureSize: options.maxTextureSize,
      maxWidth: options.maxWidth,
    };
    const message: DecodeMessage = { type: 'decode', file, request: { tier, limits } };
    worker.postMessage(message);
  });
}

import { MAX_PLAN_BYTES, type PlanImageType, type TourPlan } from '@internal/contracts';
import {
  ApiError,
  putFile,
  UPLOAD_CONTENT_TYPES,
  type UploadApi,
  type XhrLike,
} from '@internal/web-kit';

// A floor-plan image is served as uploaded, from the public CDN. So the editor redraws
// it first: that drops the photo's metadata (a camera's GPS position, say), caps its size,
// and leaves a plain JPG, PNG or WebP. A plan this size reads fine in a 240px map.

/** Longest side of a stored plan image, px. */
export const PLAN_EDGE = 2048;
/** Biggest file the editor will open as a plan, before it is redrawn. */
export const MAX_PLAN_INPUT_BYTES = 30 * 1024 * 1024;
const QUALITY = 0.85;

export interface PreparedPlan {
  blob: Blob;
  type: PlanImageType;
  width: number;
  height: number;
}

/** Turns a picked file into the image to upload; throws a PlanImageError the user can read. */
export type PlanPreparer = (file: File) => Promise<PreparedPlan>;

export class PlanImageError extends Error {
  override name = 'PlanImageError';
}

/** The size to draw a `width`×`height` image at: its longest side at most PLAN_EDGE. */
export function planSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PLAN_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Checks a picked file before it is decoded: type and bytes. */
export function checkPlanFile(file: { type: string; size: number }): void {
  if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    throw new PlanImageError('Use a JPG, PNG or WebP image.');
  }
  if (file.size <= 0) throw new PlanImageError('This file is empty.');
  if (file.size > MAX_PLAN_INPUT_BYTES) {
    throw new PlanImageError('This image is larger than 30 MB.');
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));

/** The browser's own redraw: decode, scale onto a white canvas, encode as WebP (or JPG). */
export const preparePlanImage: PlanPreparer = async (file) => {
  checkPlanFile(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PlanImageError('This image can’t be opened. Try another file.');
  }
  const size = planSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new PlanImageError('This browser can’t prepare the image.');
  }
  // White behind a transparent plan, as the map draws it.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  // Safari can't encode WebP and quietly hands back a PNG: use a JPG there instead.
  let blob = await toBlob(canvas, 'image/webp');
  if (blob?.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg');
  if (!blob || (blob.type !== 'image/webp' && blob.type !== 'image/jpeg')) {
    throw new PlanImageError('This browser can’t prepare the image.');
  }
  if (blob.size > MAX_PLAN_BYTES) {
    throw new PlanImageError('This image is too detailed to use as a plan. Try a simpler one.');
  }
  return { blob, type: blob.type, ...size };
};

/**
 * What the editor says when a plan image couldn't be added. A refusal upload-api names
 * (a limit, a disabled or deleted account, uploads paused) says which, in words; anything
 * else is worth another try.
 */
export function planErrorMessage(e: unknown): string {
  if (e instanceof PlanImageError) return e.message;
  if (e instanceof ApiError && [403, 410, 429, 503].includes(e.status)) return e.message;
  return 'The image couldn’t be added. Try again.';
}

export interface PlanUploadDeps {
  upload: Pick<UploadApi, 'presignPlan'>;
  prepare: PlanPreparer;
  createXhr?: () => XhrLike;
}

/** Prepares the file, uploads it to a fresh key of the tour's, and returns the plan to save. */
export async function uploadPlanImage(
  deps: PlanUploadDeps,
  tourId: string,
  file: File,
): Promise<TourPlan> {
  const prepared = await deps.prepare(file);
  const { planId, url } = await deps.upload.presignPlan({
    tourId,
    contentType: prepared.type,
    size: prepared.blob.size,
  });
  await putFile(url, prepared.blob, {
    contentType: prepared.type,
    ...(deps.createXhr && { createXhr: deps.createXhr }),
  });
  return { id: planId, type: prepared.type, width: prepared.width, height: prepared.height };
}

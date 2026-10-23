import { isAuthError, validateUploadImage } from '@internal/web-kit';

import { FinalizeError, SignedOutBatchError } from './finalize.js';

/** What went wrong starting photos, for the upload dialog: `files` lists one line per photo. */
export interface StartProblem {
  message: string;
  files?: string[];
}

/**
 * The photos that pass the checks, and one line for each that doesn't. One at a time, so a
 * big pick never reads many large images at once.
 */
export async function checkFiles(files: readonly File[]): Promise<{
  valid: File[];
  skipped: string[];
  /** The single photo's own message, when only one was picked and it failed. */
  only: string | null;
}> {
  const valid: File[] = [];
  const skipped: string[] = [];
  let only: string | null = null;
  for (const f of files) {
    const bad = await validateUploadImage(f);
    if (!bad) valid.push(f);
    else {
      skipped.push(`${f.name}: ${bad.message}`);
      if (files.length === 1) only = bad.message;
    }
  }
  return { valid, skipped, only };
}

/** Nothing could be sent: the photo's own reason, or which photos and why. */
export function noneValid(check: { skipped: string[]; only: string | null }): StartProblem {
  return check.only !== null
    ? { message: check.only }
    : { message: 'None of these photos could be uploaded:', files: check.skipped };
}

/** The others are uploading; these were left out. */
export const someSkipped = (skipped: string[]): StartProblem => ({
  message:
    skipped.length === 1
      ? 'The other photos are uploading. This one was left out:'
      : 'The other photos are uploading. These were left out:',
  files: skipped,
});

/** A replace uses the first photo; the rest were left out. */
export const replaceTakesOne = (extras: string[]): StartProblem => ({
  message:
    extras.length === 1
      ? 'A pano is replaced with one photo. This one was left out:'
      : 'A pano is replaced with one photo. These were left out:',
  files: extras,
});

export function startProblem(e: unknown): StartProblem {
  if (e instanceof SignedOutBatchError) {
    return {
      message: `You’ve been signed out. Sign in again to continue. Only “${e.kept}” is kept while you sign in: there’s room for one photo. Add these again after:`,
      files: e.dropped,
    };
  }
  if (isAuthError(e)) return { message: 'You’ve been signed out. Sign in again to continue.' };
  // A tour that's gone or full: retrying won't help, so say exactly why.
  if (e instanceof FinalizeError) return { message: e.message };
  return { message: 'Couldn’t start the upload. Please try again.' };
}

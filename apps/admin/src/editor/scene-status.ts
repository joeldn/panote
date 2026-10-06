import type { PendingUpload } from '../upload/upload-context.js';

// Where a scene's image stands, from the upload running for it in this tab or, failing
// that, from the status polls the editor runs itself (after a reload, say).

/** A scene whose tiles aren't on stage yet, or never will be without the user. */
export type SceneStatus = 'uploading' | 'processing' | 'failed' | 'timed-out';

/** What the editor's own `?status=1` polls found for a pano. */
export type PolledTiling =
  | { state: 'pending' }
  | { state: 'ready' }
  | { state: 'failed' }
  /** Still pending after the editor's patience ran out; `checking` while it slow-polls. */
  | { state: 'timed-out'; checking: boolean };

/** `ready`: the tiles exist. `unknown`: nothing says either way (the usual case). */
export type Tiling = SceneStatus | 'ready' | 'unknown';

/** What an upload job says about its pano's tiles. */
export function tilingOfJob(p: PendingUpload): Tiling {
  const m = p.machine;
  switch (m.phase) {
    case 'preparing':
    case 'upload':
      return 'uploading';
    case 'processing':
      return 'processing';
    case 'timed-out':
      return 'timed-out';
    case 'ready':
      return 'ready';
    case 'failed':
      if (m.stage === 'tiling') return 'failed';
      // Signed out after the image landed: tiling goes on, the poll resumes after sign-in.
      if (m.stage === 'auth' && m.resumable) return 'processing';
      // The upload itself failed: whatever was there before is still there.
      return 'unknown';
    case 'cancelled':
      return 'unknown';
  }
}

const tilingOfPoll = (p: PolledTiling): Tiling => (p.state === 'pending' ? 'processing' : p.state);

/**
 * A pano's tiles, newest source first: an upload of it in this tab, then the editor's
 * own polls, then a finished upload this session (its reload key).
 */
export function tilingOf(
  panoId: string,
  jobs: readonly PendingUpload[],
  polled: PolledTiling | undefined,
  reloadedThisSession: boolean,
): Tiling {
  // Newest last in `pendingFor`: a retry supersedes the job it replaced.
  const job = jobs.findLast((p) => p.panoId === panoId);
  if (job) {
    const t = tilingOfJob(job);
    if (t !== 'unknown') return t;
  }
  if (polled) return tilingOfPoll(polled);
  return reloadedThisSession ? 'ready' : 'unknown';
}

export const sceneStatusOf = (t: Tiling): SceneStatus | null =>
  t === 'ready' || t === 'unknown' ? null : t;

/**
 * Look-only: while a scene's image is still uploading (a new pano, or a replace whose
 * PUT is in flight) it can be looked at but not edited. Once the image lands the scene
 * is editable while it tiles: the preview and the tiles share one mapping, so points
 * and views set on the preview land on the same pixels.
 */
export const isLookOnly = (s: SceneStatus | null): boolean => s === 'uploading';

/** The pano's upload hasn't added it to the tour yet: an add with no scene of its own. */
export function isPendingCard(p: PendingUpload, sceneIds: readonly string[]): boolean {
  return p.target.kind === 'add' && (p.panoId === null || !sceneIds.includes(p.panoId));
}

/** The short line under a pending card's name. */
export function pendingLine(p: PendingUpload): string {
  const m = p.machine;
  if (p.finalize.status === 'failed') {
    return p.finalize.auth ? 'Sign in again to add it' : 'Couldn’t add it to the tour';
  }
  // In the tour on the server; this editor picks it up on its next sync or reload.
  if (p.finalize.status === 'done') return 'Added to the tour';
  switch (m.phase) {
    case 'preparing':
      return 'Preparing…';
    case 'upload':
      return `Uploading ${m.pct}%`;
    case 'processing':
    case 'timed-out':
    case 'ready':
      return 'Adding to the tour…';
    case 'failed':
      if (m.stage === 'auth') return 'Sign in again to finish';
      return m.stage === 'tiling' ? 'Couldn’t process the image' : 'Upload failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** The upload's determinate progress, while there is one. */
export const pendingPct = (p: PendingUpload): number | null =>
  p.machine.phase === 'upload' ? p.machine.pct : p.machine.phase === 'preparing' ? 0 : null;

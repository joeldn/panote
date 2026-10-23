import { Button } from '@internal/ui';

import type { SceneStatus } from './scene-status.js';

export interface StageStatusProps {
  status: SceneStatus;
  /** The scene's name, for the failed and timed-out cards. */
  name: string;
  /** The line to show while uploading (a pending card's, with its progress). */
  uploadLine?: string;
  /** Replace image (opens the file dialog); absent for an upload that has no scene yet. */
  onReplace?: () => void;
  onRemove?: () => void;
  /** Timed-out only: poll again. Absent while still checking on its own. */
  onCheckAgain?: () => void;
  /** An upload with no scene yet that failed: `uploadLine` says how, the chip fixes it. */
  problem?: boolean;
}

const UPLOADING_NOTE = 'Look around while it uploads; editing unlocks once it lands.';
const PROCESSING_NOTE = 'You can keep editing; the full-resolution tiles swap in once it’s ready.';

/**
 * What the stage says about a scene whose tiles aren't in: a quiet note while it
 * uploads or processes (the local preview stays visible), a card with Replace and
 * Remove once it failed or is taking too long.
 */
export function StageStatus({
  status,
  name,
  uploadLine,
  onReplace,
  onRemove,
  onCheckAgain,
  problem = false,
}: StageStatusProps) {
  if (problem) {
    return (
      <p className="ed-stage-note ed-stage-note--busy" role="alert">
        <i className="fa-solid fa-circle-exclamation" aria-hidden="true" />{' '}
        {uploadLine ?? 'The upload stopped'}. Try again or dismiss it from the upload status.
      </p>
    );
  }
  if (status === 'uploading' || status === 'processing') {
    const what =
      status === 'uploading'
        ? `${uploadLine ?? 'Uploading the new image'}.`
        : 'Processing this pano.';
    return (
      <p className="ed-stage-note ed-stage-note--busy" role="status">
        <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true" /> {what}{' '}
        {status === 'uploading' ? UPLOADING_NOTE : PROCESSING_NOTE}
      </p>
    );
  }
  const failed = status === 'failed';
  return (
    <div className="ed-stage-card" role="alert" aria-labelledby="ed-stage-card-title">
      <div className="ed-missing">
        <i
          className={`fa-solid ${failed ? 'fa-triangle-exclamation' : 'fa-hourglass-half'}`}
          aria-hidden="true"
        />
        <h2 id="ed-stage-card-title">
          {failed ? 'We couldn’t process this image' : 'Still processing'}
        </h2>
        <p>
          {failed
            ? `We hit an error processing “${name}”. Replace its image to try again, or remove it from the tour.`
            : onCheckAgain
              ? `“${name}” is taking longer than usual. Check again, replace its image, or remove it from the tour.`
              : `“${name}” is taking longer than usual. We’ll keep checking, or you can replace its image or remove it from the tour.`}
        </p>
        <div className="ed-stage-card__actions">
          {onCheckAgain && (
            <Button variant="ghost" size="sm" onClick={onCheckAgain}>
              Check again
            </Button>
          )}
          {onReplace && (
            <Button variant="primary" size="sm" onClick={onReplace}>
              Replace image
            </Button>
          )}
          {onRemove && (
            <Button variant="danger" size="sm" onClick={onRemove}>
              Remove from tour
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

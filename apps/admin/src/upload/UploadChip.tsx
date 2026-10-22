import { createPortal } from 'react-dom';

import { useAspectNote } from './aspect-note.js';
import type { ChipActionId, ChipModel } from './chip-model.js';

export interface UploadChipProps {
  model: ChipModel;
  /** The picked photo, when there is one: a photo that isn't 2:1 gets a note while it uploads and tiles. */
  file?: Blob | null | undefined;
  onAction(id: ChipActionId): void;
  onDismiss(): void;
}

function Indicator({ tone }: { tone: ChipModel['tone'] }) {
  if (tone === 'ready') {
    return <i className="up-chip__ok fa-solid fa-check" aria-hidden="true" />;
  }
  if (tone === 'failed' || tone === 'timed-out') {
    return <i className="up-chip__warn fa-solid fa-exclamation" aria-hidden="true" />;
  }
  return <span className="up-chip__spin" aria-hidden="true" />;
}

/** The fixed bottom-right upload/processing chip (design screens 10–12, plus failed/timed-out). */
export function UploadChip({ model, file, onAction, onDismiss }: UploadChipProps) {
  const aspect = useAspectNote(file);
  const showAspect = aspect !== null && (model.tone === 'upload' || model.tone === 'processing');
  const chip = (
    <section className={`up-chip up-chip--${model.tone}`} aria-label="Upload status">
      <div className="up-chip__head">
        <Indicator tone={model.tone} />
        <p className="up-chip__title" role="status">
          {model.title}
        </p>
        <button
          type="button"
          className="up-chip__close"
          aria-label={model.dismissLabel}
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      {model.label && (
        <div className="up-chip__meta">
          <span>{model.label}</span>
          <span>{model.value}</span>
        </div>
      )}
      {model.bar === 'determinate' && (
        <div
          className="up-chip__bar"
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={model.pct ?? 0}
        >
          <span style={{ width: `${model.pct ?? 0}%` }} />
        </div>
      )}
      {model.bar === 'indeterminate' && (
        <div className="up-chip__bar up-chip__bar--indet" role="progressbar" aria-label="Tiling">
          <span />
        </div>
      )}
      <p className="up-chip__note">{model.note}</p>
      {showAspect && (
        <p className="up-chip__aspect" role="note">
          <i className="fa-solid fa-circle-info" aria-hidden="true" />
          {aspect}
        </p>
      )}
      {model.actions.length > 0 && (
        <div className="up-chip__actions">
          {model.actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="up-chip__action"
              onClick={() => onAction(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
  // Portalled to <body> like the modals, so it floats over every route.
  return createPortal(chip, document.body);
}

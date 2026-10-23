import { LogoMark, Modal, Notice, useModalTitleId } from '@internal/ui';
import { UPLOAD_CONTENT_TYPES } from '@internal/web-kit';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { targetFromParams, type UploadTarget } from './resume-store.js';
import { useUploads } from './upload-context.js';
import { repickNotice } from './repick-notice.js';
import {
  checkFiles,
  noneValid,
  someSkipped,
  startProblem,
  type StartProblem,
} from './start-files.js';

export interface UploadOverlayProps {
  target: UploadTarget;
  /** Shown above the drop zone, e.g. "choose the photo again" after a sign-in redirect. */
  notice?: string | undefined;
  /**
   * After a sign-in redirect: take back the file stashed before it, and start
   * with it; `missingNotice` asks for it again if there is none.
   */
  resume?: { take(): Promise<File | null>; missingNotice: string } | undefined;
  /** What went wrong with photos picked or dropped outside the dialog. */
  problem?: StartProblem | undefined;
  onClose(): void;
  onStarted?(result: { tourId: string | null }): void;
}

const TITLES: Record<UploadTarget['kind'], string> = {
  'new-tour': 'New tour',
  add: 'Add pano',
  replace: 'Replace image',
};

type Status =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** `files`: one line per photo the message is about, when several were picked. */
  | ({ kind: 'error' } & StartProblem);

/** The upload overlay (design screen 03): a drop zone that validates and starts an upload. */
export function UploadOverlay({
  target,
  notice,
  resume,
  problem,
  onClose,
  onStarted,
}: UploadOverlayProps) {
  const uploads = useUploads();
  const titleId = useModalTitleId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>(
    problem ? { kind: 'error', ...problem } : { kind: 'idle' },
  );
  const [dragging, setDragging] = useState(false);
  const [missing, setMissing] = useState(false);
  // A replace takes one image; a new tour or Add pano takes several, uploaded in turn.
  const multiple = target.kind !== 'replace';
  // An upload already under way doesn't block: these join the queue behind it.
  const queues = uploads.busy;
  const disabled = status.kind === 'starting';

  async function accept(picked: File[]) {
    if (picked.length === 0 || disabled) return;
    await start(multiple ? picked : picked.slice(0, 1));
  }

  async function start(files: File[]) {
    setStatus({ kind: 'starting' });
    const check = await checkFiles(files);
    if (check.valid.length === 0) {
      setStatus({ kind: 'error', ...noneValid(check) });
      return;
    }
    try {
      const result = await uploads.begin(check.valid, target);
      setStatus({ kind: 'idle' });
      onStarted?.(result);
      // The rest are on their way: say which were left out (this dialog has closed).
      if (check.skipped.length > 0) uploads.report(target, someSkipped(check.skipped));
    } catch (e) {
      setStatus({ kind: 'error', ...startProblem(e) });
    }
  }

  // A ref, not effect cleanup: StrictMode's second run must not take (and drop) the file twice.
  const resumed = useRef(false);
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    setStatus({ kind: 'starting' });
    void resume.take().then((file) => {
      if (file) return start([file]);
      setStatus({ kind: 'idle' });
      setMissing(true);
    });
    // Once per overlay: `resume` is read on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shownNotice = notice ?? (missing ? resume?.missingNotice : undefined);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void accept([...e.dataTransfer.files]);
  };

  return (
    <Modal open onClose={onClose} width={560} labelledBy={titleId}>
      <div className="up-overlay">
        <h2 id={titleId} className="up-overlay__title">
          <LogoMark size={24} />
          {TITLES[target.kind]}
        </h2>
        {shownNotice && (
          <Notice role="note" className="up-overlay__notice">
            {shownNotice}
          </Notice>
        )}
        {queues && (
          <Notice role="note" className="up-overlay__notice">
            Another upload is still running. Anything you add here waits its turn.
          </Notice>
        )}
        <button
          type="button"
          className={`up-drop${dragging ? ' up-drop--over' : ''}`}
          disabled={disabled}
          aria-describedby={`${titleId}-hint`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="up-drop__icon" aria-hidden="true">
            <i className="fa-solid fa-arrow-up" />
          </span>
          <span className="up-drop__label">
            {status.kind === 'starting'
              ? 'Starting upload…'
              : multiple
                ? 'Choose 360° photos'
                : 'Choose a 360° photo'}
          </span>
          <span id={`${titleId}-hint`} className="up-drop__hint">
            {multiple
              ? 'or drop them here · 2:1 JPG, PNG or WebP, up to 150 MB each'
              : 'or drop it here · 2:1 JPG, PNG or WebP, up to 150 MB'}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={UPLOAD_CONTENT_TYPES.join(',')}
          multiple={multiple}
          data-testid="upload-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void accept(files);
          }}
        />
        {status.kind === 'error' && (
          <div className="up-overlay__error" role="alert">
            <p>{status.message}</p>
            {status.files && (
              <ul>
                {status.files.map((line, i) => (
                  // Two photos can share a name and a reason: the position keeps keys apart.
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button type="button" className="up-overlay__cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/**
 * `/app/new`: a new tour from one or more panos, or (from the editor) `?tour=<id>[&replace=<panoId>]`.
 * `?resume=upload` is where sign-in from the landing returns.
 */
export function NewPanoOverlay() {
  const uploads = useUploads();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // A sign-in redirect that lost the file: this overlay (not the provider's picker) asks again.
  const lost = uploads.repick?.reason === 'signed-out' ? uploads.repick : null;
  const target = lost?.target ?? targetFromParams(params);
  // From the target, never the raw `tour` param: a resumed replace keeps its own tour.
  const tour = target.kind === 'new-tour' ? null : target.tourId;
  const resume =
    params.get('resume') === 'upload' || lost
      ? {
          take: uploads.takePendingFile,
          missingNotice: lost
            ? repickNotice(lost)
            : 'You’re signed in. Choose your photo again to upload it.',
        }
      : undefined;
  return (
    <UploadOverlay
      key={`${target.kind}:${tour ?? ''}`}
      target={target}
      resume={resume}
      onClose={() => {
        uploads.clearRepick();
        void navigate(tour ? `/t/${tour}` : '/');
      }}
      onStarted={({ tourId }) => {
        const to = tourId ?? tour;
        // A new tour opens asking for its name, as it does from the dashboard.
        const state = target.kind === 'new-tour' ? { newTour: true } : undefined;
        if (to) void navigate(`/t/${to}`, { state });
      }}
    />
  );
}

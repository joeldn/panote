import { LogoMark, Modal, useModalTitleId } from '@internal/ui';
import { isAuthError, UPLOAD_CONTENT_TYPES, validateUploadImage } from '@internal/web-kit';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import type { UploadTarget } from './resume-store.js';
import { useUploads } from './upload-context.js';
import { repickNotice } from './repick-notice.js';

export interface UploadOverlayProps {
  target: UploadTarget;
  /** Shown above the drop zone, e.g. "choose the photo again" after a sign-in redirect. */
  notice?: string | undefined;
  /**
   * After a sign-in redirect: take back the file stashed before it, and start
   * with it; `missingNotice` asks for it again if there is none.
   */
  resume?: { take(): Promise<File | null>; missingNotice: string } | undefined;
  onClose(): void;
  onStarted?(result: { tourId: string | null }): void;
}

const TITLES: Record<UploadTarget['kind'], string> = {
  'new-tour': 'New pano',
  add: 'Add pano',
  replace: 'Replace image',
};

type Status = { kind: 'idle' } | { kind: 'starting' } | { kind: 'error'; message: string };

const startError = (e: unknown): string =>
  isAuthError(e)
    ? 'You’ve been signed out. Sign in again to continue.'
    : 'Couldn’t start the upload. Please try again.';

/** The upload overlay (design screen 03): a drop zone that validates and starts an upload. */
export function UploadOverlay({ target, notice, resume, onClose, onStarted }: UploadOverlayProps) {
  const uploads = useUploads();
  const titleId = useModalTitleId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [missing, setMissing] = useState(false);
  const blocked = uploads.busy;
  const disabled = blocked || status.kind === 'starting';

  async function accept(file: File | undefined) {
    if (!file || disabled) return;
    await start(file);
  }

  async function start(file: File) {
    setStatus({ kind: 'starting' });
    const invalid = await validateUploadImage(file);
    if (invalid) {
      setStatus({ kind: 'error', message: invalid.message });
      return;
    }
    try {
      const result = await uploads.begin(file, target);
      setStatus({ kind: 'idle' });
      onStarted?.(result);
    } catch (e) {
      setStatus({ kind: 'error', message: startError(e) });
    }
  }

  // A ref, not effect cleanup: StrictMode's second run must not take (and drop) the file twice.
  const resumed = useRef(false);
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    setStatus({ kind: 'starting' });
    void resume.take().then((file) => {
      if (file) return start(file);
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
    void accept(e.dataTransfer.files[0]);
  };

  return (
    <Modal open onClose={onClose} width={560} labelledBy={titleId}>
      <div className="up-overlay">
        <h2 id={titleId} className="up-overlay__title">
          <LogoMark size={24} />
          {TITLES[target.kind]}
        </h2>
        {shownNotice && (
          <p className="up-overlay__notice" role="note">
            {shownNotice}
          </p>
        )}
        {blocked && (
          <p className="up-overlay__notice" role="note">
            Another upload is still in progress. Wait for it to finish, or cancel it, first.
          </p>
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
            {status.kind === 'starting' ? 'Starting upload…' : 'Drop an equirectangular photo'}
          </span>
          <span id={`${titleId}-hint`} className="up-drop__hint">
            or click to browse · JPG, PNG or WebP, up to 150 MB
          </span>
          <span className="up-drop__mono">2:1 ratio works best</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={UPLOAD_CONTENT_TYPES.join(',')}
          data-testid="upload-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void accept(file);
          }}
        />
        {status.kind === 'error' && (
          <p className="up-overlay__error" role="alert">
            {status.message}
          </p>
        )}
        <button type="button" className="up-overlay__cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/** `/app/new`: a new tour from one pano. `?resume=upload` is where sign-in from the landing returns. */
export function NewPanoOverlay() {
  const uploads = useUploads();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const lost = uploads.repick?.target.kind === 'new-tour' ? uploads.repick : null;
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
      target={{ kind: 'new-tour' }}
      resume={resume}
      onClose={() => {
        uploads.clearRepick();
        void navigate('/');
      }}
      onStarted={({ tourId }) => {
        if (tourId) void navigate(`/t/${tourId}`);
      }}
    />
  );
}

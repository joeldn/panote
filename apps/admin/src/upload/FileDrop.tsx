import { useEffect, useRef, useState } from 'react';

import type { UploadTarget } from './resume-store.js';
import { useUploads } from './upload-context.js';

const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
// An open dialog (the upload dialog, a replace, a confirm) owns the page while it's up.
const dialogOpen = () => document.querySelector('[aria-modal="true"]') !== null;

/**
 * Photos dragged anywhere over the page start uploading for `target` when dropped there,
 * with a full-page hint while they hover. The upload dialog's own drop zone takes its own.
 */
export function FileDrop({ target, label }: { target: UploadTarget; label: string }) {
  const uploads = useUploads();
  const [over, setOver] = useState(false);
  // Read at drop time, so the listeners stay put while uploads and the page change.
  const latest = useRef({ uploads, target });
  useEffect(() => {
    latest.current = { uploads, target };
  });

  useEffect(() => {
    // dragenter/dragleave fire for every element crossed: count them to know when it left.
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth++;
      setOver(!dialogOpen());
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    // Without this the browser opens the photo in the tab instead of dropping it.
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!carriesFiles(e)) return;
      // The upload dialog's drop zone already took it.
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (dialogOpen()) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length > 0) latest.current.uploads.drop(files, latest.current.target);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="up-page-drop" role="status">
      <span className="up-page-drop__label">
        <i className="fa-solid fa-arrow-up" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}

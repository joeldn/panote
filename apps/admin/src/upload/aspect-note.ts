import { readImageSize, type ImageSize } from '@internal/web-kit';
import { useEffect, useState } from 'react';

/** How far from 2:1 a photo can be before the creator is told. Stitchers are often a few px off. */
const TOLERANCE = 0.02;

export const WIDE_NOTE =
  'This photo doesn’t cover the full view up and down. We’ll fill the top and bottom so it displays without stretching.';
export const NARROW_NOTE =
  'This photo isn’t a 2:1 panorama, so it will look stretched in the viewer.';

/**
 * A non-blocking note for a photo that isn't 2:1, matching what the tiler does with it
 * (packages/tiler/src/equirect.ts): a wider one is padded top and bottom, a narrower one
 * is stretched over the sphere. Null for a 2:1 photo, or when the size is unknown.
 */
export function aspectNote(size: ImageSize | null): string | null {
  if (!size || size.width <= 0 || size.height <= 0) return null;
  const ratio = size.width / size.height;
  if (ratio > 2 * (1 + TOLERANCE)) return WIDE_NOTE;
  if (ratio < 2 * (1 - TOLERANCE)) return NARROW_NOTE;
  return null;
}

/** aspectNote for a picked file, read from its header. Null until read, and with no file. */
export function useAspectNote(file: Blob | null | undefined): string | null {
  const [read, setRead] = useState<{ file: Blob; note: string | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    readImageSize(file).then(
      (size) => {
        if (live) setRead({ file, note: aspectNote(size) });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [file]);
  return read && read.file === file ? read.note : null;
}

import type { PanoViewer } from '@panote/viewer';
import { createContext, useContext } from 'react';

export const PanoViewerContext = createContext<PanoViewer | null>(null);

/** The stage's viewer, for chrome rendered as PanoStage children; null until mounted. */
export const usePanoViewer = (): PanoViewer | null => useContext(PanoViewerContext);

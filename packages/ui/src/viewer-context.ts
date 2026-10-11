import type { PanoViewerApi } from '@panote/viewer';
import { createContext, useContext } from 'react';

export const PanoViewerContext = createContext<PanoViewerApi | null>(null);

/** The stage's viewer, for chrome rendered as PanoStage children; null until mounted. */
export const usePanoViewer = (): PanoViewerApi | null => useContext(PanoViewerContext);

import { createContext, useContext } from 'react';

/**
 * What stage chrome reports to the app through PanoStage, for analytics. The
 * viewer only renders; facts about panote's own UI (a point opened) travel
 * here instead of through it.
 */
export interface StageEvents {
  /** A point's panel was opened; PanoStage hands it to `onHotspotOpen`. */
  hotspotOpen(hotspotId: string): void;
}

const NONE: StageEvents = { hotspotOpen: () => {} };

export const StageEventsContext = createContext<StageEvents>(NONE);

/** The enclosing PanoStage's event sink; a no-op outside one. */
export const useStageEvents = (): StageEvents => useContext(StageEventsContext);

import type { usePanoViewer, ViewerFactory } from '@internal/ui';
import { createContext } from 'react';

/** Test seam: jsdom has no WebGL, so tests provide a fake PanoViewer factory. */
export const StageFactoryContext = createContext<ViewerFactory | undefined>(undefined);

export type Viewer = NonNullable<ReturnType<typeof usePanoViewer>>;

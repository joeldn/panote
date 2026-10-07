import type { ViewerFactory } from '@internal/ui';
import { createContext } from 'react';

/** Test seam: jsdom has no WebGL, so tests provide a fake PanoViewer factory. */
export const StageFactoryContext = createContext<ViewerFactory | undefined>(undefined);

import { useParams } from 'react-router';

import { Placeholder } from './Shell.js';

export type ShareTab = 'link' | 'privacy' | 'embed';

// Route placeholders; the real screens land in the D units (docs/wave6-plan.md 4.3).
export { Dashboard } from './dashboard/Dashboard.js';

export { NewPanoOverlay as UploadOverlay } from './upload/UploadOverlay.js';

export { Editor } from './editor/Editor.js';

export function Preview() {
  const { tourId } = useParams();
  return <Placeholder title={`Preview ${tourId ?? ''}`} />;
}

export { ShareRoute as ShareModal } from './share/ShareRoute.js';
export { InsightsRoute as InsightsModal } from './insights/InsightsRoute.js';
export const NotFound = () => <Placeholder title="Page not found" />;

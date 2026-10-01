import { Outlet, useParams } from 'react-router';

import { Placeholder } from './Shell.js';

export type ShareTab = 'link' | 'privacy' | 'embed';

// Route placeholders; the real screens land in the D units (docs/wave6-plan.md 4.3).
export { Dashboard } from './dashboard/Dashboard.js';

export const UploadOverlay = () => <p role="dialog">Upload</p>;

export function Editor() {
  const { tourId } = useParams();
  return (
    <Placeholder title={`Editor ${tourId ?? ''}`}>
      <Outlet />
    </Placeholder>
  );
}

export function Preview() {
  const { tourId } = useParams();
  return <Placeholder title={`Preview ${tourId ?? ''}`} />;
}

export const ShareModal = ({ tab }: { tab: ShareTab }) => <p role="dialog">Share: {tab}</p>;
export const InsightsModal = () => <p role="dialog">Insights</p>;
export const NotFound = () => <Placeholder title="Page not found" />;

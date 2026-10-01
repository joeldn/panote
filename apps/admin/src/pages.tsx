import { Outlet, useParams } from 'react-router';

import { Placeholder } from './Shell.js';

export type ShareTab = 'link' | 'privacy' | 'embed';

// Route placeholders; the real screens land in the D units (docs/wave6-plan.md 4.3).
export function Dashboard() {
  return (
    <Placeholder title="Dashboard">
      <Outlet />
    </Placeholder>
  );
}

export { NewPanoOverlay as UploadOverlay } from './upload/UploadOverlay.js';

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

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

export const UploadOverlay = () => <p role="dialog">Upload</p>;
export const Callback = () => <Placeholder title="Signing in" />;

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

export { ShareRoute as ShareModal } from './share/ShareRoute.js';
export const InsightsModal = () => <p role="dialog">Insights</p>;
export const NotFound = () => <Placeholder title="Page not found" />;

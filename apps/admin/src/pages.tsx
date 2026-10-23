import { Placeholder } from './Shell.js';

export type ShareTab = 'link' | 'privacy' | 'embed';

// Route placeholders; the real screens land in the D units (docs/wave6-plan.md 4.3).
export { Dashboard } from './dashboard/Dashboard.js';
export { UnusedPanos } from './dashboard/UnusedPanos.js';

export { NewPanoOverlay as UploadOverlay } from './upload/UploadOverlay.js';

export { Editor } from './editor/Editor.js';

export { Preview } from './preview/Preview.js';

export { ShareRoute as ShareModal } from './share/ShareRoute.js';
export { InsightsRoute as InsightsModal } from './insights/InsightsRoute.js';
export { PeopleRoute as PeopleModal } from './people/PeopleRoute.js';
export { InviteRoute as Invite } from './people/InviteRoute.js';
export { AccountRoute as Account } from './account/AccountRoute.js';
export { OpsRoute as Ops, OpsOverview } from './ops/OpsRoute.js';
export const NotFound = () => <Placeholder title="Page not found" />;

import { Placeholder } from './Shell.js';

// `?signin=1` opens the sign-in modal from the Shell, on any page.
export { Explore } from './explore/Explore.js';
export { Landing } from './landing/Landing.js';
export { Privacy, Terms } from './legal/Legal.js';
export const NotFound = () => <Placeholder title="Page not found" />;

import { Placeholder } from './Shell.js';

// `?signin=1` opens the sign-in modal from the Shell, on any page.
export { Landing } from './landing/Landing.js';
export { ContentPolicy, Privacy, Terms } from './legal/Legal.js';
export const NotFound = () => <Placeholder title="Page not found" />;

import { Placeholder } from './Shell.js';

// Route placeholders; the real screens land in the D units (docs/wave6-plan.md 4.3).
// `?signin=1` opens the sign-in modal from the Shell, on any page.
export const Landing = () => <Placeholder title="Landing" />;

export const Privacy = () => <Placeholder title="Privacy" />;
export const Terms = () => <Placeholder title="Terms" />;
export const NotFound = () => <Placeholder title="Page not found" />;

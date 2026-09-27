import { useSearchParams } from 'react-router';

import { Placeholder } from './Shell.js';

// Route placeholders; the real screens land in the D units (docs/wave6-plan.md 4.3).
export function Landing() {
  const [params] = useSearchParams();
  return (
    <Placeholder title="Landing">
      {params.get('signin') === '1' && <p role="dialog">Sign-in modal (unit C3)</p>}
    </Placeholder>
  );
}

export const Privacy = () => <Placeholder title="Privacy" />;
export const Terms = () => <Placeholder title="Terms" />;
export const NotFound = () => <Placeholder title="Page not found" />;

import '../dashboard/dashboard.css';
import './ops.css';

import { NavLink, Outlet } from 'react-router';

import { Placeholder } from '../Shell.js';
import { useSession } from '../session.js';
import { useIsOperator } from './operator.js';
import { OPS_SECTIONS } from './sections.js';

/**
 * /app/ops: the operator area. Anyone the server doesn't list as an operator sees the
 * same "Page not found" as any unknown path, and every /api/admin/ops call 404s for them
 * anyway, so this is presentation, not the guard.
 */
export function OpsRoute() {
  const { api } = useSession();
  const operator = useIsOperator(api);
  if (operator === null) {
    return (
      <p className="app-status" role="status">
        Loading…
      </p>
    );
  }
  if (!operator) return <Placeholder title="Page not found" />;
  return (
    <section className="dash ops">
      <header className="dash__head">
        <div>
          <p className="dash__kicker">Operator</p>
          <h1 className="dash__title">Operations</h1>
        </div>
      </header>
      <nav className="ops__nav" aria-label="Operations">
        {OPS_SECTIONS.map((s) => (
          <NavLink
            key={s.path}
            to={s.path ? `/ops/${s.path}` : '/ops'}
            end
            className={({ isActive }) => `ops__tab${isActive ? ' ops__tab--active' : ''}`}
          >
            {s.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </section>
  );
}

/** The overview until the metrics dashboard lands in it. */
export function OpsOverview() {
  return <p className="ops__empty">Nothing to show here yet.</p>;
}

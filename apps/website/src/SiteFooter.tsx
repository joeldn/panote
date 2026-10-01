import { Logo } from '@internal/ui';
import { Link } from 'react-router';

import { CONTACT_EMAIL, NAV_SECTIONS } from './landing/content.js';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__cols">
        <div>
          <Logo />
          <p className="site-footer__blurb">
            Free, full-resolution 360° tours. No watermark, no paywall.
          </p>
        </div>
        <nav aria-label="Product">
          <div className="site-footer__label">Product</div>
          {NAV_SECTIONS.map((s) => (
            <Link key={s.id} to={`/#${s.id}`}>
              {s.label}
            </Link>
          ))}
        </nav>
        <div>
          <div className="site-footer__label">Contact</div>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </div>
      </div>
      <div className="site-footer__bottom">
        <span>© 2026 Panote · Free, unlimited, no watermark</span>
        <nav aria-label="Legal" className="site-footer__legal">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}

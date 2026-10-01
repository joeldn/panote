import './legal.css';

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { CONTACT_EMAIL } from '../landing/content.js';

const UPDATED = '1 October 2026';

const Mail = () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="legal">
      <h1>{title}</h1>
      <p className="legal__updated">Last updated {UPDATED}</p>
      {children}
    </article>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>
        Panote is a free service for publishing 360° panoramas and tours. This page says what we
        collect, why, and who helps us run it. The short version: we keep what we need to run your
        account and show your tours, we count visits without personal data, and we don’t sell
        anything about you.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with Google. Sign-in is handled by Auth0, which passes us your name, email
        address, profile picture and an account id. We use these to sign you in, show who is signed
        in, and link your tours to you. Your browser keeps the sign-in session in local storage so
        you stay signed in between visits.
      </p>

      <h2>What you upload</h2>
      <p>
        Panoramas, tour titles, hotspot text and other content you add are stored on Cloudflare and
        served from our content network. A tour you publish can be opened by anyone with its link; a
        public tour may also be shown elsewhere on Panote. When you delete a tour or panorama we
        remove it from storage and our caches.
      </p>

      <h2>Visitors and analytics</h2>
      <p>
        <strong>Visits are counted without personal data.</strong> When someone opens a tour we
        record anonymous counts — views, time spent in the tour (dwell), and which panoramas and
        hotspots were opened — in Cloudflare Workers Analytics Engine. These records hold the tour,
        panorama and hotspot they relate to, not who the visitor is: no names, no accounts, no IP
        addresses. We use no cookies for analytics and no third-party trackers.
      </p>
      <p>
        Liking a tour stores a random id in your browser’s local storage so a like counts once. It
        isn’t linked to an account. Tour owners see totals only.
      </p>

      <h2>Who helps us run Panote</h2>
      <ul>
        <li>Cloudflare: hosting, storage, content delivery and visit counts.</li>
        <li>Auth0 (Okta): sign-in.</li>
        <li>Google: the account you sign in with.</li>
      </ul>
      <p>We don’t show ads and we don’t sell or rent personal data.</p>

      <h2>Your choices</h2>
      <p>
        You can edit, unpublish or delete your tours at any time. To delete your account, or to ask
        what we hold about you, email <Mail />.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes we’ll update this page and the date above. See also our{' '}
        <Link to="/terms">terms</Link>.
      </p>
    </LegalPage>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms">
      <p>
        These terms cover your use of Panote (panote.io). By signing in or publishing a tour you
        agree to them.
      </p>

      <h2>The service</h2>
      <p>
        Panote is free. We host your panoramas and tours and serve them to the people you share them
        with. We may change, limit or stop parts of the service, and we’ll give notice where we
        reasonably can.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of everything you upload. You give us permission to store, process (for
        example, tile for zooming) and show it, only as needed to run Panote and in the way you set
        it up — for example as an unlisted or public tour. You can unpublish or delete it at any
        time.
      </p>
      <p>
        Only upload content you have the right to share. Don’t upload anything illegal, anything
        that infringes someone else’s rights, or images of people who haven’t agreed to be shown. We
        may remove content or suspend an account that breaks these rules.
      </p>

      <h2>Fair use</h2>
      <p>
        Don’t try to break, overload or get around the limits of the service, or use it to
        distribute malware or spam.
      </p>

      <h2>No warranty</h2>
      <p>
        Panote is provided as it is, without warranties of any kind. As far as the law allows, we
        aren’t liable for indirect or consequential losses, or for loss of content. Keep your own
        copies of your originals.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms; the date above shows the latest version. Questions: <Mail />. See
        also our <Link to="/privacy">privacy policy</Link>.
      </p>
    </LegalPage>
  );
}

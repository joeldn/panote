import './legal.css';

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { CONTACT_EMAIL } from '../landing/content.js';
import { OPERATOR_ADDRESS, OPERATOR_JURISDICTION, OPERATOR_NAME } from './operator.js';

const Mail = () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <article className="legal">
      <h1>{title}</h1>
      <p className="legal__updated">Last updated {updated}</p>
      {children}
    </article>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy" updated="22 October 2026">
      <p>
        Panote is a free service for publishing 360° panoramas and tours. This page says what we
        collect, why, and who helps us run it. The short version: we keep what we need to run your
        account and show your tours, we count visits without personal data, and we don’t sell
        anything about you.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with an account you already have with Google, Apple, Microsoft or Facebook
        (whichever the sign-in screen offers). Sign-in is handled by Auth0, which passes us an
        account id and, where the provider shares them, your name, email address and profile
        picture. We use these to sign you in, show who is signed in, and link your tours to you.
        Your browser keeps the sign-in session in local storage so you stay signed in between
        visits.
      </p>

      <h2>What you upload</h2>
      <p>
        Panoramas, tour titles, hotspot text and other content you add are stored on Cloudflare and
        served from our content network. A tour you publish can be opened by anyone with its link; a
        public tour may also be shown elsewhere on Panote. When you delete a tour or panorama we
        remove it from storage and our caches, except for content held after a report (see below).
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
        So a like counts once, liking a tour while signed out stores a random id in your browser’s
        local storage, and liking it while signed in records your account id against that tour. Tour
        owners see totals only. Deleting your account doesn’t remove likes you gave on other
        people’s tours.
      </p>

      <h2>Who helps us run Panote</h2>
      <ul>
        <li>Cloudflare: hosting, storage, content delivery and visit counts.</li>
        <li>Auth0 (Okta): sign-in.</li>
        <li>Google, Apple, Microsoft or Facebook: whichever account you sign in with.</li>
      </ul>
      <p>We don’t show ads and we don’t sell or rent personal data.</p>

      <h2>Your choices</h2>
      <p>
        You can edit, unpublish or delete your tours at any time. You can also delete your whole
        account yourself: once signed in, open the account menu and choose Delete account. That
        removes your tours, panoramas, share links and visit counts, and your sign-in record is
        removed within 30 days. Content held after a report is the one exception, below. To ask what
        we hold about you, email <Mail />.
      </p>

      <h2>Reports and legal holds</h2>
      <p>
        If we remove content under our{' '}
        <Link to="/content-policy">content and copyright policy</Link>, we may keep a private copy
        of it, with the account id it belonged to and the details of the report, as evidence for as
        long as the law requires. That copy is never shown publicly, and it stays even if the
        account is deleted. When you send us a report or a copyright notice, we keep your contact
        details and what you sent in our private record of reports, and may pass a copyright notice
        on to the owner of the content.
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
    <LegalPage title="Terms" updated="22 October 2026">
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
      <p>
        Our <Link to="/content-policy">content and copyright policy</Link> is part of these terms.
        It says what isn’t allowed, how to report a tour, how copyright notices and counter-notices
        work, and what happens to accounts that break the rules.
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

// Operator details still undecided show as their placeholder, marked so nobody mistakes them.
const Operator = ({ value }: { value: string }) => <span className="legal__todo">{value}</span>;

export function ContentPolicy() {
  return (
    <LegalPage title="Content and copyright" updated="22 October 2026">
      <p>
        Panote hosts the panoramas and tours people upload. This page says what isn’t allowed, how
        to report a tour, and what we do when we get a report. It is part of our{' '}
        <Link to="/terms">terms</Link>.
      </p>
      <p>
        Panote is run by <Operator value={OPERATOR_NAME} />, <Operator value={OPERATOR_ADDRESS} />.
        Every report and notice below goes to <Mail />.
      </p>

      <h2>What isn’t allowed</h2>
      <ul>
        <li>Photos or panoramas you don’t have the right to share, such as someone else’s work.</li>
        <li>Images of people who haven’t agreed to be shown, above all in private places.</li>
        <li>Any sexual content involving someone under 18. We report it to the authorities.</li>
        <li>Anything else that is illegal to publish where you or your viewers are.</li>
        <li>Content that threatens or harasses someone, or exposes their private information.</li>
        <li>Malware, spam or misleading links in hotspots.</li>
      </ul>

      <h2>Report a tour</h2>
      <p>
        Use the Report link on the tour, or email <Mail /> with the tour’s link and what is wrong
        with it. We read every report. If it is about copyright, send a notice as described below so
        we can act on it.
      </p>

      <h2>Copyright notices</h2>
      <p>
        If you believe a tour uses your work without permission, email <Mail /> a notice that
        includes:
      </p>
      <ul>
        <li>your name, postal address, phone number and email address;</li>
        <li>
          the work you say is being infringed, for example the original photo or where it is
          published;
        </li>
        <li>the link to the tour on Panote, and which panorama in it if there are several;</li>
        <li>
          a statement that you believe in good faith that the use isn’t authorised by you, your
          agent or the law;
        </li>
        <li>
          a statement that the information in your notice is accurate and, under penalty of perjury,
          that you own the rights or are authorised to act for the owner;
        </li>
        <li>your signature: typing your full name is enough.</li>
      </ul>
      <p>
        If something is missing we’ll ask for it before we act. Don’t send a notice you know to be
        false: you may be liable for the harm it causes.
      </p>

      <h2>What we do</h2>
      <p>
        When we get a complete notice we remove the content or disable access to it, usually by
        taking the tour offline so its link stops working. We tell the owner what was removed and
        why, and pass on the notice.
      </p>

      <h2>Counter-notices</h2>
      <p>
        If your content was removed and you believe that was a mistake, or that you have the right
        to use it, email <Mail /> a counter-notice that includes:
      </p>
      <ul>
        <li>your name, postal address, phone number and email address;</li>
        <li>what was removed and the link where it appeared;</li>
        <li>
          a statement, under penalty of perjury, that you believe in good faith it was removed by
          mistake or because it was misidentified;
        </li>
        <li>
          a statement that you consent to the jurisdiction of the courts of{' '}
          <Operator value={OPERATOR_JURISDICTION} />, and will accept service of legal papers from
          the person who sent the notice;
        </li>
        <li>your signature: typing your full name is enough.</li>
      </ul>
      <p>
        We pass the counter-notice on to the person who sent the notice. If they don’t tell us
        within 10 to 14 working days that they have started legal action, we may put the content
        back.
      </p>

      <h2>Repeat infringers</h2>
      <p>
        We keep a record of the notices we act on. An account that keeps getting valid notices is
        closed, and its tours and panoramas are deleted.
      </p>

      <h2>Illegal images</h2>
      <p>
        Child sexual abuse material, and anything else that is illegal to host, is taken offline as
        soon as we know about it, without warning the owner. We keep a private copy where the law
        requires it and report it to the authorities: in the US that is the National Center for
        Missing &amp; Exploited Children (NCMEC), elsewhere the national hotline or the police. The
        account is closed.
      </p>
      <p>
        If you come across such content, report it to us and to your national hotline or the police.
        Send us the link only, never the images themselves.
      </p>

      <h2>Other reports</h2>
      <p>
        For anything else, such as a photo of you shown without your agreement, we look at the
        report and may remove the content or suspend the account. Questions about this policy go to{' '}
        <Mail />.
      </p>
    </LegalPage>
  );
}

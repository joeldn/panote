import './legal.css';

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { CONTACT_EMAIL } from '../landing/content.js';

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
    <LegalPage title="Privacy" updated="23 October 2026">
      <p>
        Panote is a free, non-commercial hobby project for sharing 360° panoramas, run by one person
        you can reach at <Mail />. This page says what data it uses and why. There are no ads, no
        tracking cookies, and nothing is sold.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li>
          <strong>Your account.</strong> You sign in through Auth0 with Google, Apple, Microsoft or
          Facebook, or with a one-time code we email to you. We get an account id and, if the
          provider shares them, your name, email address and profile picture. Google, Apple and
          email-code sign-ins with the same verified email address are joined into one account;
          Microsoft and Facebook each keep a separate one. You only need an account to upload, not
          to view tours.
        </li>
        <li>
          <strong>What you upload.</strong> Panoramas, tours and their text. Anyone with a published
          tour’s link can open it. A public tour is also listed on Explore (title, cover image and
          scene count, never your name) and can appear in search once your account is a week old.
        </li>
        <li>
          <strong>Likes.</strong> Signed out, a random id in your browser’s local storage, so a like
          counts once. Signed in, your account id against the tour.
        </li>
        <li>
          <strong>Visit counts.</strong> Anonymous views, time spent and hotspots opened. No names,
          accounts or IP addresses.
        </li>
        <li>
          <strong>IP addresses</strong> are used for about a minute to limit abuse.
        </li>
        <li>
          <strong>Logs and error reports.</strong> Cloudflare’s request logs (which include IP
          addresses) and short error reports from your browser (with email addresses and tour links
          removed) help fix problems. They are deleted within 30 days.
        </li>
      </ul>

      <h2>Who else handles it</h2>
      <ul>
        <li>Cloudflare: hosting, storage and visit counts.</li>
        <li>Auth0: sign-in. Plus whichever provider you sign in with.</li>
        <li>An email delivery provider: sign-in codes.</li>
        <li>
          YouTube, Vimeo or another site, only when you open a hotspot that plays media from it.
          That site sees your IP address and may set cookies under its own policy.
        </li>
      </ul>
      <p>Some of these are in the US.</p>

      <h2>Deleting</h2>
      <p>
        You can delete tours, panoramas or your whole account (account menu, Delete account) at any
        time. Private backups and the originals of deleted photos are kept for up to 31 days in case
        of mistakes, and your sign-in record is removed within 30 days. Unpublishing stops a tour’s
        link working, but people who already viewed it may still load its images until you delete
        them. If content is taken down after a report, a private copy and the report may be kept as
        long as the law requires.
      </p>

      <h2>Your rights</h2>
      <p>
        Email <Mail /> to see, correct or delete your data, or to object to how it is used. If you
        aren’t happy with the answer, you can complain to your data protection authority. Your data
        is used to run the service you signed up for and to keep it secure and working.
      </p>

      <h2>Children</h2>
      <p>Panote isn’t for anyone under 16.</p>

      <h2>Changes</h2>
      <p>
        If this page changes, the date above changes too. See also the{' '}
        <Link to="/terms">terms</Link>.
      </p>
    </LegalPage>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms" updated="23 October 2026">
      <p>
        Panote (panote.io) is a free, non-commercial hobby project. By signing in or publishing a
        tour you agree to these terms. You must be 16 or older to sign in.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of what you upload. You let Panote store, process and show it, as needed
        to run the service and in the way you set it up, for example as a public tour on Explore.
      </p>
      <p>
        Only upload what you have the right to share: nothing illegal, nothing that infringes
        someone else’s rights, and no images of people who haven’t agreed to be shown. The{' '}
        <Link to="/content-policy">content and copyright policy</Link> has the details.
      </p>

      <h2>Fair use</h2>
      <p>
        Don’t try to break, overload or get around the limits of the service, or use it for malware
        or spam.
      </p>

      <h2>No guarantees</h2>
      <p>
        Panote is provided as it is, and may change or stop at any time. It’s a hobby project, so
        keep your own copies of your originals. As far as the law allows, Panote isn’t liable for
        any loss, including loss of content.
      </p>

      <h2>Ending</h2>
      <p>
        You can delete your account at any time. Content or accounts that break these terms may be
        removed.
      </p>

      <h2>Changes and contact</h2>
      <p>
        These terms may change; the date above shows the latest version. Questions: <Mail />. See
        also the <Link to="/privacy">privacy policy</Link>.
      </p>
    </LegalPage>
  );
}

export function ContentPolicy() {
  return (
    <LegalPage title="Content and copyright" updated="23 October 2026">
      <p>
        What isn’t allowed on Panote, and how to report it. This page is part of the{' '}
        <Link to="/terms">terms</Link>.
      </p>

      <h2>What isn’t allowed</h2>
      <ul>
        <li>Photos you don’t have the right to share, such as someone else’s work.</li>
        <li>Images of people who haven’t agreed to be shown, above all in private places.</li>
        <li>
          Anything illegal, threatening or harassing, or that exposes someone’s private details.
        </li>
        <li>Malware, spam or misleading links.</li>
      </ul>

      <h2>Report a tour</h2>
      <p>
        Use the Report link on the tour, or email <Mail /> with the tour’s link and what’s wrong.
        For copyright, say which work is yours and how to reach you. Every report is read, and
        content that breaks these rules is taken down.
      </p>

      <h2>What happens next</h2>
      <p>
        When something is taken down, its owner is told why. If you think it was a mistake, reply to
        that email. Accounts that keep breaking the rules are closed.
      </p>

      <h2>Illegal images</h2>
      <p>
        Child sexual abuse material is taken down straight away, reported to the authorities (NCMEC
        in the US, the national hotline elsewhere), and the account is closed. If you find any, send
        the link only, never the images.
      </p>
    </LegalPage>
  );
}

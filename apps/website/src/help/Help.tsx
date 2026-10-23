import './help.css';

import { MAX_HOTSPOTS, MAX_TOUR_SCENES, SLUG_MAX_LENGTH } from '@internal/contracts';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_PIXELS } from '@internal/web-kit';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';

import { ACCOUNT_LIMITS, CONTACT_EMAIL } from '../landing/content.js';
import { HELP_PAGES } from './pages.js';

// Help pages (B12). Copy rules: Panote is free and not open source, makes no promise of
// taking work back out, and these pages use no em-dashes (help.test.tsx checks).

const MAX_MB = MAX_UPLOAD_BYTES / 1024 ** 2;
const MAX_MP = MAX_UPLOAD_PIXELS / 1e6;

function HelpPage({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <div className="help">
      <title>{`${title} · panote`}</title>
      <nav className="help__nav" aria-label="Help pages">
        {HELP_PAGES.map((p) => (
          <NavLink key={p.path} to={p.path} end className="help__nav-link">
            {p.label}
          </NavLink>
        ))}
      </nav>
      <article className="help__body">
        <h1>{title}</h1>
        <p className="help__lede">{lede}</p>
        {children}
        <p className="help__contact">
          Still stuck? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </article>
    </div>
  );
}

const Code = ({ children }: { children: string }) => <code className="help__code">{children}</code>;

/** `/help`: getting started and what each part of the editor does. */
export function Help() {
  return (
    <HelpPage
      title="Help"
      lede="Panote turns 360° photos into tours people can step inside, shared as a link or embedded in your own site. It’s free, with no watermark. This page walks through making a tour from start to finish."
    >
      <h2>Make your first tour</h2>
      <ol>
        <li>
          <strong>Sign in</strong> with an account you already have or, where the sign-in screen
          offers it, your email address and a one-time code. There’s no password to remember.
        </li>
        <li>
          <strong>Upload a panorama.</strong> Press <em>New tour</em> and pick one or more 360°
          photos. They upload one at a time, in the order you picked them, into the same tour. See
          the <Link to="/help/cameras">camera guide</Link> for which photos work.
        </li>
        <li>
          <strong>Wait a moment for processing.</strong> While a photo uploads you can already look
          around a preview of it. Once it lands we cut it into tiles, so visitors can zoom into
          every pixel without waiting for the whole file.
        </li>
        <li>
          <strong>Build the tour</strong> in the editor: points, connections between panos, the map
          and the tour’s settings, all described below.
        </li>
        <li>
          <strong>Save.</strong> Press <em>Save</em> (or Ctrl+S, ⌘S on a Mac). The first save puts
          the tour online as <em>Unlisted</em>: anyone with the link can open it. After that, every
          save updates what the link shows.
        </li>
      </ol>

      <h2>The editor</h2>
      <p>
        The pano fills the screen. Drag to look around, and scroll or pinch to zoom. Click the tour
        title or the pano’s name in the top bar to rename them. Edits are kept in this browser as
        you go, so a closed tab doesn’t lose them, but nobody sees them until you save.
      </p>
      <p>
        On a narrow screen the language, settings, Insights and Preview buttons move into the{' '}
        <em>More</em> menu (<span aria-hidden="true">•••</span>) in the top bar.
      </p>

      <h3>Points</h3>
      <p>
        Points are the markers visitors open for more about a spot. Press <em>Add point</em>, then
        click the pano where it goes; drag as you drop it to make it bigger. Each point has a title,
        text with Markdown formatting, an icon and a size, and can show an image, audio, a video, a
        YouTube or Vimeo video, or a link. You can move, duplicate or delete a point from its panel.
        A pano holds up to {MAX_HOTSPOTS} points.
      </p>

      <h3>Start view and north</h3>
      <p>
        Turn the view to where visitors should first look and press <em>Start here</em>. Turn to
        face north and press <em>North is here</em>: the compass and the mini-map use it to show
        which way a visitor is facing.
      </p>

      <h3>The Tour card</h3>
      <ul>
        <li>Click a pano in the list to open it in the editor.</li>
        <li>
          The star marks the pano the tour starts at. Without one, it starts at the first pano in
          the list.
        </li>
        <li>
          Drag a pano by its handle to change the order visitors see the panos in. From the
          keyboard, focus the handle and use the arrow keys, or Home and End.
        </li>
        <li>
          <strong>Connections</strong> are the arrows on the floor that visitors walk between panos
          with. They point <em>from</em> the open pano: face the way the next pano is and press{' '}
          <em>Aim here</em> beside it. Nudge an arrow 5° at a time, or remove it. A connection goes
          one way, so open the other pano and aim one back.
        </li>
        <li>
          The camera button replaces a pano’s photo and keeps its points. The cross removes it from
          the tour; its photo and points are kept, and a pano no other tour uses shows up under{' '}
          <em>Unused panos</em> on your dashboard.
        </li>
        <li>
          <em>Add pano</em> uploads more photos into the tour. <em>From library</em> adds one you’ve
          already uploaded. A tour holds up to {MAX_TOUR_SCENES} panos.
        </li>
      </ul>

      <h3>The Map card</h3>
      <p>
        Open the Map card to show where each pano was taken. Drag a pano’s dot around the plan, or
        click the plan to put the open pano there. Add a floor plan image (JPG, PNG or WebP) to draw
        on, and keep north at the top. Visitors see the plan as a mini-map, with the scene list
        under it.
      </p>

      <h3>Tour settings and languages</h3>
      <p>
        The sliders button holds the tour’s description and how the viewer looks: controls at the
        bottom or the top, the mini-map, the compass, and a slow auto-rotate when nobody is
        dragging. The globe button adds languages: switch to one and type the translated tour title,
        description, pano names and points. Blank fields show the main language’s text, and each
        visitor sees their own language when the tour has it.
      </p>

      <h2>Sharing</h2>
      <p>
        Press <em>Share</em> in the editor. The <em>Link</em> tab copies the tour’s link, posts it
        to social networks, and lets you choose its address: lower-case letters, digits and dashes,
        up to {SLUG_MAX_LENGTH} characters. When you change it, the old address keeps working for a
        while; the share sheet says until when.
      </p>
      <p>
        The <em>Privacy</em> tab has two choices. <strong>Public</strong> tours are listed on{' '}
        <Link to="/explore">Explore</Link> and can appear in search. <strong>Unlisted</strong> tours
        open only for people who have the link. <em>Stop sharing</em> takes the link and every embed
        offline until you share the tour again. The <em>Embed</em> tab gives you code for your own
        site; see <Link to="/help/embedding">embedding a tour</Link>.
      </p>

      <h2>Your dashboard and insights</h2>
      <p>
        Your dashboard lists your tours. On each card, the chip switches a shared tour between
        Public and Unlisted, and the buttons open the live tour, copy its link, show its insights,
        duplicate it or delete it. Insights show a tour’s views, its views per day over the last two
        weeks, how long visitors stay, and which panos and points they open. Visits are counted
        without personal data.
      </p>

      <h2>Limits</h2>
      <p>
        Everything is free. Each account holds up to {ACCOUNT_LIMITS.panoramas} panoramas,{' '}
        {ACCOUNT_LIMITS.tours} tours and {ACCOUNT_LIMITS.storageGb} GB, and can upload up to{' '}
        {ACCOUNT_LIMITS.uploadsPerDay} photos a day. A photo can be up to {MAX_MB} MB and {MAX_MP}{' '}
        megapixels.
      </p>
    </HelpPage>
  );
}

/** `/help/cameras`: which photos work, and how to shoot them. */
export function CameraGuide() {
  return (
    <HelpPage
      title="Camera guide"
      lede="Panote shows 360° photos in the equirectangular format nearly every 360 camera and stitching app produces. Here’s what that means, and how to shoot panoramas that make a good tour."
    >
      <h2>What Panote needs</h2>
      <ul>
        <li>
          <strong>An equirectangular photo:</strong> the whole sphere around the camera unrolled
          into one flat image, twice as wide as it is tall (2:1), such as 6080 × 3040 or 11904 ×
          5952 pixels.
        </li>
        <li>
          <strong>JPG, PNG or WebP</strong>, up to {MAX_MB} MB and {MAX_MP} megapixels. We never
          scale it down: visitors zoom into the detail you captured.
        </li>
        <li>
          A photo wider than 2:1 doesn’t cover the full view up and down, so we fill the top and
          bottom to show it without stretching. One narrower than 2:1 looks stretched. The upload
          tells you when a photo isn’t 2:1.
        </li>
      </ul>

      <h2>Cameras and apps</h2>
      <h3>One-shot 360 cameras</h3>
      <p>
        Cameras such as the Ricoh Theta, Insta360 X series and GoPro Max take the whole sphere in
        one shot. Some save a finished 360° JPG straight away. Others keep the two lens images side
        by side in their own file format: open it in the camera’s phone or desktop app and save it
        as a 360° photo (a stitched JPG) first. That JPG is the file to upload.
      </p>
      <h3>Phone panoramas and photo spheres</h3>
      <p>
        A phone’s ordinary panorama mode is not a 360° photo and will look stretched. A photo sphere
        app does make equirectangular images, but they often miss part of the sky or the floor;
        those parts show as a plain band.
      </p>
      <h3>Stitching from a regular camera</h3>
      <p>
        Shooting overlapping frames on a panoramic head and stitching them in an app such as PTGui
        or Hugin gives the most detail. Set the output projection to equirectangular, covering 360°
        across and 180° up and down.
      </p>

      <h2>Shooting tips</h2>
      <ul>
        <li>
          Use a tripod or monopod at about eye height, and keep the camera level so the horizon
          stays straight.
        </li>
        <li>
          Stand in the open part of a room, away from walls. Close objects stitch badly, so keep
          about a metre from anything you want to look sharp.
        </li>
        <li>
          Point the camera the same way, say north, at every spot. Setting <em>North is here</em> in
          the editor is quick when every pano faces the same way.
        </li>
        <li>
          Take a pano every few steps where people would walk, so each one can see the next. That’s
          where the connection arrows go.
        </li>
        <li>
          Use the camera’s HDR mode when windows are much brighter than the room, and wait for
          people to move out of shot, or step behind the camera yourself.
        </li>
        <li>
          A tour shows everything in the photo. Check for faces, number plates, documents and
          anything else private before you upload.
        </li>
      </ul>
    </HelpPage>
  );
}

const SNIPPET = `<iframe src="https://panote.io/s/your-tour/embed"
  width="100%" height="480" style="border:0"
  allow="fullscreen"></iframe>`;

/** `/help/embedding`: putting a tour on your own site. */
export function Embedding() {
  return (
    <HelpPage
      title="Embedding a tour"
      lede="Put a tour on your own website with a short piece of code. The embed is the full viewer, at full resolution, with no watermark."
    >
      <h2>Get the code</h2>
      <ol>
        <li>Open the tour in the editor and save it, so it’s shared.</li>
        <li>
          Press <em>Share</em> and open the <em>Embed</em> tab.
        </li>
        <li>
          Choose <strong>Whole tour</strong>, so visitors can walk between every pano, or{' '}
          <strong>This pano only</strong> for the pano open in the editor, with no arrows out.
        </li>
        <li>
          Pick a height: Compact (380 px), Standard (480 px) or Large (660 px). A tour with more
          than one language also lets you fix the language; otherwise each visitor sees their own.
        </li>
        <li>
          Press <em>Copy code</em>. <em>Preview</em> shows the embed as it will look.
        </li>
      </ol>
      <p>The code is a plain iframe, so there’s nothing to install:</p>
      <pre className="help__pre">
        <code>{SNIPPET}</code>
      </pre>

      <h2>Paste it into your site</h2>
      <ul>
        <li>WordPress: add a Custom HTML block and paste the code.</li>
        <li>Squarespace: add a Code block.</li>
        <li>Webflow: add an Embed element.</li>
        <li>
          Notion: type <Code>/embed</Code> and paste the link from the code’s <Code>src</Code>.
        </li>
        <li>Your own HTML: paste it where the tour should appear.</li>
      </ul>
      <p>
        Then publish the page and check it on a phone. The embed fills the width of the space you
        put it in; change the <Code>height</Code> if it feels cramped.
      </p>

      <h2>How it behaves</h2>
      <ul>
        <li>
          It shows the tour as you set it up: controls, mini-map, compass and auto-rotate follow the
          tour’s settings.
        </li>
        <li>Saving in the editor updates every embed of the tour. There’s no code to change.</li>
        <li>
          Public and Unlisted tours can both be embedded. Embedding doesn’t list an unlisted tour
          anywhere.
        </li>
        <li>
          If you stop sharing the tour, its embeds show a short “not available” message until you
          share it again.
        </li>
        <li>
          Visitors can go full screen from the controls. Where the browser can’t do that inside an
          embed, as on iPhone, the button opens the tour in a new tab instead.
        </li>
      </ul>

      <h2>Troubleshooting</h2>
      <ul>
        <li>
          <strong>Nothing shows:</strong> some site builders strip iframes from ordinary text
          blocks. Use the builder’s HTML, code or embed block instead.
        </li>
        <li>
          <strong>Your site sets a Content Security Policy:</strong> allow the tour’s address in{' '}
          <Code>frame-src</Code>, for example <Code>frame-src https://panote.io</Code>.
        </li>
        <li>
          <strong>Full screen doesn’t work:</strong> keep <Code>allow="fullscreen"</Code> on the
          iframe when you edit the code.
        </li>
      </ul>
    </HelpPage>
  );
}

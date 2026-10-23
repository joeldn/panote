# Design handoff notes

How to read `docs/design/` against the current code, as of 2026-10-22.

## What it is

A Claude Design handoff dated 2026-08-10 covering the full hosted app shell:
landing → sign-in → dashboard → upload → editor → viewer → share/embed, plus
the owner Insights modal. `README.md` is the high-fidelity spec — colours,
type, spacing, motion, and copy are final; recreate the UI pixel-accurately.
`screens/` has one PNG per screen/state (13 total). `prototype/` is reference
only: don't lift its code. It fakes the pano engine with a CSS-transformed
equirectangular image — the real `PanoViewer` from `@panote/viewer` wins,
only the UI chrome around it has to match.

## Copy rule

The product is free, not open source. No "open source", "MIT", "GitHub", or
export/download promises in UI copy.

## Where API_BRIEF.md disagrees with the code

The brief was written against the older pano-viewer API. Where they conflict,
the code wins:

1. **Routes.** Admin routes are under `/api/admin/*`, not the brief's flat
   `/api/panos/*` (see `docs/decisions.md`). `/api/tours/*` stats/view/like
   paths are unchanged.
2. **CDN reads.** The brief has the editor/viewer fetch `manifest.json`,
   `config.json`, and `tour.json` all straight from the CDN as `GET
   {cdn}/{key}` — no owner segment, no separate get-config/tour API. Tiles
   and the manifest do work that way: owner-free at `tiles/<panoId>/…`, not
   `{cdn}/{panoId}/…` (see `docs/decisions.md`). `config.json`/`tour.json`
   don't — they live under the private `panos/<owner>/<panoId>/config.json`
   and `tours/<owner>/<tourId>/tour.json` prefixes
   (`packages/contracts/src/keys.ts`), which the CDN's WAF blocks (it only
   serves `/tiles/`, `/pub/`, `/slugs/`). So the owner's editor/dashboard
   can't read its own config/tour straight from the CDN the way the brief
   assumes — that's why the deferred admin-api `GET` routes are needed.
   Public reads of a tour/config are planned via Wave 6's published `pub/`
   copies and `slugs/<slug>.json` — neither exists yet.
3. **Read base URL.** The prototype hardcodes `panote.io`; the read base URL
   must be per-environment config. The brief's note that dev has no
   `cdn.panote.dev` is out of date — it's live in dev (see `docs/deploy.md`).

## Where the design leads the API (net-new work, not mistakes)

- A richer dashboard list endpoint — titles, thumbs, counts, updated times.
  Ties in with the deferred admin-api `GET` routes.
- Insights analytics — 14-day series, average time, most-opened points.
- Per-pano likes (the API currently has per-tour likes).
- Public/Unlisted visibility and custom slugs.
- Schema extensions: north offset, point icon/size, media embeds, i18n,
  tour-wide map/compass settings. All built. The design's `langs[]`/`lang`/`i18n{}`
  became `TourDoc.languages` plus an `i18n` map beside each translated field (see
  `docs/decisions.md`); the editor's language switcher sits in the top-right bar.
- The 2D floor-plan mini-map. Built: the editor's **Map** card places each pano on
  the plan (drag its dot, click the plan, or the arrow keys) and takes an optional
  plan image; the viewer's Map panel draws the dots as buttons over it, keeps the
  scene list under them, and turns a facing wedge on the current dot.
- **Several photos at once.** The design's drop zone takes one file. New tour and
  Add pano take several: they upload one at a time, in the order picked, into one
  tour. The chip shows the file in flight plus "N more waiting" and a "Cancel the
  rest" action; waiting files show as "Waiting" cards in the editor. An account
  limit or a sign-in stops the rest, and the chip says how many never started.
  Add pano opens over the editor, so unsaved edits stay; the editor folds each
  appended scene into its draft. Replace image still takes one file.

## Mini-map: how the code reads the design

The prototype keeps `mx`/`my` per scene and draws a plan in the corner. The code:

- **Coordinates.** `mapX`/`mapY` are 0..1 fractions of the plan, x right and y
  down (`packages/contracts/src/plan.ts`). With a plan image they are fractions of
  the image. Tours saved before this held any units; they still parse, and both
  the viewer and the editor fit such a set into the plan by its bounding box, the
  way the viewer always drew them. Placing a scene in the editor converts the whole
  set to fractions, where it was drawn.
- **North is up.** The plan is drawn with north at the top, so the editor's hint
  says to keep it that way. The facing wedge on the current dot only shows for a
  scene whose north has been set ("North is here"); without it there is no way to
  know which way the view faces on the plan.
- **Plan image.** Not in the prototype. The editor redraws the picked image in the
  browser (WebP, or JPG where the browser can't encode WebP, at most 2048 px on its
  long side and 4 MB) before it goes up, which also drops its photo metadata. See
  `docs/decisions.md` for where it is stored.
- **Suggest positions.** Not in the prototype. A button on the Map card lays out
  the panos not on the plan yet from their links: each link's yaw, less its pano's
  north, is the compass bearing to the linked pano (or the link back, turned round,
  when only the other end's north is set), and each pano goes one step along it
  from the panos already placed. Panos with no direction to go by sit beside a
  linked one, or near the middle. Placed dots never move, and the whole layout is
  one tour edit. It is a first draft for the creator to drag into place.
- **Editor layout.** The design has no editor screen for the plan. It is a third
  card under Points and Tour, collapsed to its title (with an "n of m placed"
  count) until opened, so the side column keeps its room.

## Where the code deliberately drops part of the design

- **Standalone panos.** The design lets a pano live outside any tour: shared
  on its own ("Shareable on its own") and later attached with "Add to a
  tour". That was dropped. The app is tour-centric: every upload goes into a
  tour, the tour is the only thing that is published, shared or embedded, and
  a pano has no public page of its own. A pano removed from a tour that no
  other tour uses isn't deleted; it shows up under **Unused panos** on the
  dashboard (`/?view=unused`), where the owner can put it back into a tour
  from the editor's library or delete it for good. (Deleting a whole tour
  deletes the panos only it used.)
- **Embed `allow` list.** The README's embed snippet asks for
  `allow="fullscreen; xr-spatial-tracking"`. The code asks for
  `fullscreen; gyroscope; accelerometer`: there is no VR mode, so the snippet
  shouldn't imply one, while `gyroscope` and `accelerometer` let a visitor
  look around by tilting their phone inside the embed. Embeds already pasted
  with an older list keep working; without those two the browser gives the
  embed no motion readings, and the tilt control turns itself off again
  when tried (it stays, so it can be tried again; only a refused permission
  hides it). On an iPhone, where the frame can't go fullscreen, the embed's
  fullscreen button opens the tour page in a new tab instead.

## Auth

The design's social sign-in fits the existing Auth0 setup (tenant
`panote-dev`, Google social enabled). The design shows social SSO buttons
only; the app adds an optional "Continue with email" (Auth0 passwordless, a
one-time code) below them, under an "or" divider, with the same row shape on
`--paper` with a dashed border. It only shows when the `email` connection is
enabled, and the subtitle still holds: there is no password to remember.

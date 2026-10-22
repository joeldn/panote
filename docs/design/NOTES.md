# Design handoff notes

How to read `docs/design/` against the current code, as of 2026-09-26.

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
- The 2D floor-plan mini-map — `mapX`/`mapY` already exist on `TourDoc`, but
  the viewer feature itself is not built.

## Where the code deliberately drops part of the design

- **Standalone panos.** The design lets a pano live outside any tour: shared
  on its own ("Shareable on its own") and later attached with "Add to a
  tour". That was dropped. The app is tour-centric: every upload goes into a
  tour, the tour is the only thing that is published, shared or embedded, and
  a pano has no public page of its own. A pano removed from a tour that no
  other tour uses isn't deleted; it shows up under **Unused panos** on the
  dashboard (`/panos/unused`), where the owner can put it back into a tour
  from the editor's library or delete it for good. (Deleting a whole tour
  deletes the panos only it used.)
- **Embed `allow` list.** The README's embed snippet asks for
  `allow="fullscreen; xr-spatial-tracking"`. The code asks only for
  `fullscreen`: there is no VR mode, so the snippet shouldn't imply one.
  Embeds already pasted with the old list keep working.

## Auth

The design's social sign-in fits the existing Auth0 setup (tenant
`panote-dev`, Google social enabled). The design shows social SSO buttons
only; the app adds an optional "Continue with email" (Auth0 passwordless, a
one-time code) below them, under an "or" divider, with the same row shape on
`--paper` with a dashed border. It only shows when the `email` connection is
enabled, and the subtitle still holds: there is no password to remember.

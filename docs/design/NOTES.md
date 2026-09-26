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
  tour-wide map/compass settings.
- The 2D floor-plan mini-map — `mapX`/`mapY` already exist on `TourDoc`, but
  the viewer feature itself is not built.

## Auth

The design's social sign-in fits the existing Auth0 setup (tenant
`panote-dev`, Google social enabled).

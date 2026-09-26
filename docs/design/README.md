# Handoff: Panote — hosted 360° panorama viewer & tour platform

## Overview

Panote is a free, hosted platform for publishing 360° panoramas and multi-pano tours. A creator signs in, uploads an equirectangular panorama, places information hotspots and links between panos, and shares a public link or an iframe embed. Visitors get a smooth pan/zoom viewer with hotspot panels, floor-level navigation chevrons, an optional mini-map and compass, and a share sheet.

This bundle covers the **entire hosted app shell**: marketing landing → sign-in → dashboard → upload → editor → viewer → share/embed, plus the owner Insights modal.

## About the Design Files

The files in this bundle are **design references created in HTML**. They are prototypes that demonstrate the intended look, motion, and behavior — **not production code to copy**. `Panote.dc.html` is a single-file prototype built on a small in-house component runtime (`support.js`); it is not a component library and should not be lifted into the product.

The task is to **recreate these designs in the target codebase's environment**, using its established patterns. Per the backend brief, the intended stack is **Cloudflare Pages + Vite + TypeScript**, React or Svelte both acceptable. The pano rendering engine, hotspots, tours, and share UI **already exist as a library** (`new PanoViewer(baseUrl).load(panoId)`, `setView`, `onRender`, plus mountable `controls`, `nav-arrows`, `info-hotspots`, `share` UI) — reuse it. The prototype fakes the pano engine with a CSS-transformed equirectangular image; **do not port that**.

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, shadows, motion timings, and copy are final. Recreate the UI pixel-accurately. Where the prototype's simulated engine and the real `PanoViewer` differ, the real engine wins — match the *chrome* around it exactly.

---

## Backend contract (authoritative)

Writes go through authenticated Workers; reads come straight from the R2 CDN (`cdn.panote.dev` / `cdn.panote.io`). **There is deliberately no "get config/tour" API** — the viewer/editor fetches those JSON files directly from the CDN.

**Upload worker**
- `POST /api/upload-url` (Bearer) → `{ panoId, key, url }` — `url` is a presigned PUT, valid 900s

**CRUD worker** (Bearer on all except reads/stats)
- `GET /api/panos` → `{ panoIds }` (IDs only — no titles/thumbs)
- `PUT /api/panos/:id/config` → `{ etag }` — requires `If-Match` (428 if missing, 412 if stale)
- `DELETE /api/panos/:id` → 204
- `POST /api/tours` → `{ tourId }`
- `PUT /api/tours/:id` → `{ etag }` (same `If-Match` rule)
- `POST /api/tours/:id/view` (anonymous)
- `POST /api/tours/:id/like` (needs identity — send a generated `X-Client-Id` for anonymous)
- `GET /api/tours/:id/stats` → `{ views, likes }`

**Reads (no worker):** `GET {cdn}/{key}` for `manifest.json`, `config.json`, `tour.json`, tiles.

**Data model**
- `SceneConfig: { panoId, title, description?, initialView?: {yaw,pitch,fov}, hotspots: Hotspot[] }`
- `Hotspot: { id, type: 'info' | 'link', yaw, pitch, title, body?, targetPanoId? }` — `link` requires `targetPanoId`
- `TourDoc: { tourId, title, scenes: [{ panoId, mapX?, mapY? }] }`

### Where the design deliberately leads the API

The design is the source of truth for product direction; several things it shows are **net-new backend/viewer work**, not mistakes:

| Design feature | Status vs. current API |
|---|---|
| Per-pano north offset, start view, point icon, point size/depth, media embeds, multi-language `i18n`, tour-wide control/map/compass settings | Not in `SceneConfig`/`Hotspot`/`TourDoc` — extend the schemas |
| 2D floor-plan mini-map | `mapX`/`mapY` exist in `TourDoc`; the **viewer feature itself is not built** |
| Dashboard cards (titles, cover thumbs, view counts, "updated 2 days ago") | `GET /api/panos` returns IDs only — needs a richer list endpoint |
| Insights modal (per-pano views, 14-day series, avg. time, most-opened points) | `stats` returns `{views, likes}` only — needs analytics |
| Per-pano likes | API likes are per-**tour** |
| Public / Unlisted visibility, custom slug (`panote.io/s/<slug>`) | No field, no slug-uniqueness endpoint |
| Read base URL | Hardcoded `panote.io` in the prototype — must be a per-env config value (dev has no `cdn.panote.dev` domain yet) |

---

## Screens / Views

### 1. Marketing landing (`screen: 'landing'`)

Long scrolling page on `#faf8f4`, max content width **1180px**, horizontal padding **30px**.

- **Fixed top nav** — logo mark (24px) + wordmark "panote.io" (500 18px, letter-spacing −.02em); links Features / How it works / Showcase / FAQ (hidden below 600px); "Sign in" text button; dark CTA. Nav gains a translucent backdrop-blur background after scroll.
- **Hero** — live pano behind, scrimmed. `h1` in display font, `clamp(44px, 6.6vw, 92px)`, weight 400, line-height .98, letter-spacing −.015em, max-width 15ch. Sub-paragraph 400 19px/1.5, max-width 50ch. Primary CTA is a **drop target**: dark `#1a1815` pill, 15px/22px padding, with a dashed 22px upload square, title "Upload your first tour" (600 15px) and sub "free — no sign-up, live in seconds" (400 12.5px, 60% white).
- **Pillars** — 4-up grid, 22px gap. Section `h2` `clamp(32px, 4.4vw, 54px)`, weight 400, max-width 18ch; mono kicker paragraph at 13px, 45% ink, max-width 32ch. Pillar cards: icon, mono tag, title, body. Content: Full resolution / No limits / No watermark, ever / Your work stays yours.
- **How it works** — numbered steps ("01 / Upload" style mono labels).
- **Comparison table** — 3-column grid `1.4fr 1fr 1fr`, rows separated by 1px `rgba(26,24,21,.09)`, on `#faf8f4`.
- **"Why it's free"** — dark section, reasons list with icons, plus a bordered callout (1px `rgba(250,248,244,.16)`, radius 13px, 400 15px/1.55).
- **Showcase**, **FAQ** (accordion, one open at a time), **footer** — 4 columns: brand blurb, Product, Resources (Docs / Camera guide / Embedding), Contact. Bottom bar: "© 2026 Panote · Free, unlimited, no watermark" + Privacy / Terms, 13px mono at 40% ink.

> Copy rule: the product is **free, not open source**, and makes **no export/download promises**. Do not reintroduce "open source", "MIT", "GitHub", "export your tours", or "download your config" copy anywhere.

### 2. Sign-in modal

392px card, radius 20px, padding 32px/30px, on a `rgba(20,18,14,.5)` + `blur(6px)` scrim. Centered logo, title, then social SSO buttons only (Auth0 social connections → Bearer token). Close "×" top-right, 22px, 40% ink.

### 3. Dashboard (`screen: 'dashboard'`)

Signed-in home. Header with logo, totals (tours / views / panos), account avatar (38px circle, `#1a1815`, initial) opening a menu. Tour cards in a grid: cover image with scrim, a **visibility chip** top-left (click cycles Public ↔ Unlisted), a "Current" accent badge, pano/view counts bottom-right, and title/meta below. Row actions: open, duplicate, delete (delete goes through the confirm modal).

### 4. Upload overlay (`screen: 'upload'`)

560px card, radius 20px, padding 38px. Dashed drop zone (2px dashed `rgba(26,24,21,.22)`, radius 16px, 48px/24px padding) wrapping a hidden `<input type="file" accept="image/*">`; 52px dark rounded icon tile above the label. Accepts drop or click; either路 enters the editor and starts the upload/processing sequence.

### 5. Upload → processing chip (**the fire-and-poll UI**)

Fixed bottom-right, 262px, `rgba(20,18,14,.92)` + backdrop blur, radius 14px, padding 15px/16px, text `#f4f1ea`, shadow `0 10px 34px rgba(0,0,0,.3)`.

Three phases, driven by elapsed time in the prototype and by **real events** in production:

| Phase | Title | Indicator | Note line |
|---|---|---|---|
| `upload` | "Uploading panorama" | **Determinate** 4px bar with live `%` — driven by the presigned `PUT` progress event | "Full-resolution original — keep this tab open" |
| `processing` | "Processing on our side" | **Indeterminate** 4px bar, a 42%-wide accent sweep animating left→right, 1.15s ease-in-out infinite | "Tiling takes a moment. We'll switch over the second it lands." |
| `ready` | "Ready at full resolution" | Green `#5fae6e` 16px check circle | "Tiles cached · zoom into every pixel" |

The split is deliberate and load-bearing: the upload PUT **is** measurable, and polling `{cdn}/{panoId}/manifest.json` for a 200 **is not** — never show a fake percentage during tiling. Poll with backoff; a 200 on `manifest.json` is the "ready" flag. **Add a failed/timed-out state with retry** — the prototype does not have one and production needs it.

Implementation note learned the hard way: do **not** drive these transitions from `requestAnimationFrame` alone — rAF stops in a backgrounded tab and the chip strands mid-flight. Drive from real upload/poll events (or an interval), and keep the phase computation pure.

### 6. Editor (`screen: 'editor'`)

Full-bleed pano with floating glass chrome (`--cbg` + `--cbf`).

- **Top-left**: editable tour title and pano name (click to edit inline, Enter commits).
- **Top-right**: language switcher, tour-settings gear, **Save** button, account.
- **Save is explicit** — one `PUT` per save, batching all edits since the last save. Load the current JSON to capture its **ETag**, send it as `If-Match`, and handle **412 with a conflict state** (the prototype has none — design it: "this tour changed elsewhere — reload or overwrite").
- **Point placement**: "Add point" enters placing mode; click on the pano to drop; drag at placement sets size. Selected point opens an editor panel with title, markdown body, icon picker (searchable), size slider (rotates the view to face the point), and media embed.
- **Connections**: link panos, aim each link at the current view yaw, nudge ±degrees, remove. Links render as floor chevrons that scale with zoom and drift downward for perspective.
- **Per-pano**: start view ("start here" at current yaw) and north; **per-tour**: control placement (bottom / top), mini-map toggle, compass toggle, auto-rotate.
- **Tour settings popover**: 300px, glass, radius 16px, anchored top-right below the bar.

### 7. Viewer (`screen: 'viewer'`)

Same canvas, visitor chrome: controls pill (zoom ±, fullscreen, auto-rotate, share), floor chevrons, mini-map (bottom-left corner by default), compass, like and view counts, and hotspot panels with rendered markdown. Mobile uses bottom sheets rather than side panels.

### 8. Share modal

440px card, radius 20px, `overflow:hidden`. Header "Share this tour" (600 17px) + "×". A visibility banner: accent-tinted row, radius 11px — "This tour is **Public**".

Three tabs in a 4px-padded `rgba(26,24,21,.05)` segmented control, radius 11px:

- **Link** — 4 social share targets (icon + label), the URL in a muted mono field with a dark **Copy** button (label flips to "Copied ✓" for 1.6s), and an editable custom slug (`panote.io/s/<slug>`, lowercased, `[^a-z0-9-]` → `-`, max 40 chars, Enter/blur commits, Esc cancels).
- **Privacy** — exactly **two** options, Public and Unlisted. Selected row: 1.5px accent border + 8% accent tint, 30px accent icon tile, `fa-circle-check` at right. *(A Private option and a Published toggle were deliberately removed — keep it to two.)*
- **Embed** —
  - "What to embed": 2-up cards — **Whole tour** ("Visitors can walk between every pano") vs **This pano only** (labelled with the current pano name, "no links out").
  - "Height": segmented Compact **380** / Standard **480** / Large **660**.
  - "Embed code": dark `#14130f` block, radius 10px, mono 12px/1.55 in `#9fd0e0`, with an accent "Copy code" action. Snippet:
    ```html
    <iframe src="https://panote.io/s/<slug>/embed[?pano=<panoId>]"
      width="100%" height="480" style="border:0"
      allow="fullscreen; xr-spatial-tracking"></iframe>
    ```
  - "How to add it": three numbered steps (19px circular mono badges) — copy the code; paste into an embed block (WordPress "Custom HTML", Squarespace "Code", Webflow "Embed", Notion `/embed`, or raw HTML); publish and check on a phone.
  - Info footnote on a `rgba(26,24,21,.045)` tray: responsive, full-resolution, no watermark; picks up the tour's control/map/compass settings.

### 9. Insights modal (owner only)

560px card, max-height 88vh, scrollable, sticky header. Header title 600 17px + mono sub "`<tour>` · last 14 days". Body: two stat cards (white, 1px border, radius 14px — mono uppercase label, then display font 30px value), a 14-bar "Views over time" chart (96px tall, 4px gaps), per-pano bars (7px tracks, radius 99px), and a "Most-opened points" list with mono rank badges. All section labels are **mono 11px uppercase, letter-spacing .05em, 45% ink** — not bold body text.

Note: this modal currently shows far more than `GET /api/tours/:id/stats` returns. Either build the analytics or ship it reduced — do not fabricate numbers client-side.

### 10. Confirm modal

392px, radius 18px, padding 26px. Display-font title 21px, body 400 14px/1.55 at 62% ink, then cancel/destructive actions. Used for delete tour, delete point, remove pano from tour.

---

## Interactions & Behavior

- **Navigation**: single-page screen switch (`landing` / `upload` / `editor` / `viewer` / `dashboard`); scroll resets to top on entry.
- **Pano control**: pointer drag pans with momentum/inertia; wheel and pinch zoom; auto-rotate resumes after idle; `lookAt(yaw, pitch)` eases the view when a point is selected for sizing.
- **Floor chevrons**: positioned by yaw relative to the current view on an elliptical floor path, `perspective(440px) rotateX(63deg)`, scaled by zoom.
- **Modals**: scrim click closes; inner click stops propagation; entry animation `pn-fadeup` — 12px rise, .7s `cubic-bezier(.2,.7,.2,1)`.
- **Copy actions**: label flips to "Copied ✓" for 1600ms.
- **Likes**: persisted to `localStorage` under `panote_likes` in the prototype; production must send `X-Client-Id` and reconcile with the tour-level like count.
- **Responsive**: `<= 600px` is mobile — nav links hide, side panels become bottom sheets.
- **Loading/empty/error**: upload has the three-phase chip (add a **failed** state); save needs **saving / saved / conflict(412)** states; dashboard needs an empty state; embeds of a non-public tour need a placeholder.

## State Management

Screen-level: `screen`, `authed`, `user`, `vw`.
Tour: `title`, `scenes[]` (id, name, hue, img, `startYaw`, `north`, `mx`/`my`, views, likes), `points[]` (id, scene, `yaw01`, `pitch01`, depth, icon, title, body, media), `links{ sceneId: [{to, yaw01}] }`, `entryId`, `tourCfg{ctrlPos, showMap, showCompass}`, `langs[]`, `lang`, `i18n{}`.
Sharing: `visibility` ('public' | 'unlisted'), `slug`, `shareTab`, `embedScope`, `embedSize`.
Editor UI: `activePoint`, drafts, `placing`, `sizeOpen`, `mediaOpen`, `iconPickerOpen`, `confirm`, `saving`, `lastSaved`.
Upload: `proc { phase: 'upload' | 'processing' | 'ready', pct, ready }`.

Save flow to implement: load JSON + capture ETag → user edits accumulate locally → **Save** → `PUT` with `If-Match` → on 200 store the new ETag; on **412** show the conflict state; on **428** re-fetch and retry.

## Design Tokens

**Colors**
| Token | Value | Use |
|---|---|---|
| `--accent` | `#b5483a` | primary accent, selection, progress |
| `--ink` | `#1a1815` | primary text, dark surfaces |
| paper | `#faf8f4` | page and card background |
| `--depth` | `#2f8fb3` | depth/secondary accent |
| dark panel | `#14130f` | code blocks |
| code text | `#9fd0e0` | mono on dark |
| success | `#5fae6e` | ready check |
| scrim | `rgba(20,18,14,.5)` + `blur(6px)` | modal backdrop |
| `--cbg` / `--cbf` | `rgba(255,255,255,.9)` / `blur(12px)` | glass chrome |
| `--mbg` | `rgba(250,248,244,.62)` | muted glass |

Ink opacities in steady use: `.82` body, `.7` secondary, `.62`, `.55`, `.5`, `.45` meta, `.4` faint, `.13`/`.1`/`.09`/`.08`/`.06` borders and tracks.

**Typography** — Google Fonts: Schibsted Grotesk (display + body), Spline Sans Mono (mono). Alternate sets exist in the prototype (Spectral/Figtree, Bricolage/Hanken) but **grotesk is the shipped default**.
- Display: `'Schibsted Grotesk'`, weight 400, tight letter-spacing (−.015em at large sizes)
- Body: `'Schibsted Grotesk'` — 19px/1.5 lede, 14–15px body, 13.5px UI, 12–13px meta
- Mono: `'Spline Sans Mono'` — 11–13px, uppercase section labels at 11px / letter-spacing .05em

**Radii**: 6, 8–9 (chips), 10–11 (fields), 12–14 (cards/rows), 16–18, 20 (modals), 99/999 (pills).
**Shadows**: modal `0 40px 100px rgba(0,0,0,.4)`; chip `0 10px 34px rgba(0,0,0,.3)`; popover `0 18px 50px rgba(0,0,0,.26)`; glass control `0 2px 10px`.
**Motion**: `pn-fadeup` .7s `cubic-bezier(.2,.7,.2,1)`; `pn-spin` .8s linear; `pn-indet` 1.15s ease-in-out infinite; bar fill `.18s linear`; copy-confirm 1600ms.

**Token scoping gotcha**: all tokens must be defined on `:root`, not only on the app root element — fixed-position subtrees (processing chip, modals) render outside the app root and otherwise lose every `var(--*)`, falling back to Times and dropping the accent.

## Assets

- **Fonts**: Google Fonts (Schibsted Grotesk, Spline Sans Mono; plus Spectral, Figtree, Bricolage Grotesque, Hanken Grotesk for the alternate sets).
- **Icons**: Font Awesome 6.5.1 (`fa-solid` / `fa-brands`). The point icon picker is searchable over the FA set.
- **Logo**: "pin-horizon" — an inline SVG pin containing a curved horizon and a viewpoint dot, white-bordered sticker style, no container box. Drawn in `makeLogo(accent)`; it recolors with the accent.
- **Panorama imagery**: placeholder equirectangular photos from Wikimedia Commons. **Replace with real assets** — they are demo content only.

## Screenshots

In `screens/`. Captured from the prototype at ~910px wide — treat them as look-and-feel references; the README's measurements are authoritative. A floating "FLOW" pill (Site / My tours / Upload / Editor / Viewer) appears bottom-right in several shots — that is a **prototype-only** screen switcher, not part of the product.

| File | Shows |
|---|---|
| `01-landing.png` | Marketing hero over a live pano |
| `02-dashboard.png` | Signed-in tour dashboard with totals and tour cards |
| `03-upload.png` | Upload overlay / drop zone |
| `04-editor.png` | Editor — points panel, tour panel with connections, top bar |
| `05-viewer.png` | Visitor viewer — controls, mini-map, floor chevron |
| `06-share-link.png` | Share → Link tab (socials, URL, custom slug) |
| `07-share-privacy.png` | Share → Privacy (Public / Unlisted only) |
| `08-share-embed.png` | Share → Embed (scope, height, code, steps) |
| `09-insights.png` | Owner Insights modal |
| `10-chip-uploading.png` | Upload chip — determinate % phase |
| `11-chip-processing.png` | Upload chip — indeterminate tiling phase |
| `12-chip-ready.png` | Upload chip — ready state |
| `13-confirm-modal.png` | Destructive-action confirm modal |

## Files

- `Panote.dc.html` — the complete prototype (marketing + app, all screens, all modals)
- `support.js` — the prototype's runtime; reference only, do not port
- `API_BRIEF.md` — the backend/viewer contract as supplied

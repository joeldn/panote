# Pano-viewer — frontend design brief (backend + viewer contract)

Reference for the full UI flow (website → auth → upload → CRUD → hosted viewer).
The rendering engine, hotspots, tours, and share UI already exist as a library; the
hosted app shell (auth, upload, gallery, backend-wired viewer) is what's being designed.

## The API to design against
Writes go through authenticated Workers; reads come straight from the R2 CDN
(cdn.panote.dev / cdn.panote.io). There is deliberately NO "get config/tour" API —
the viewer/editor fetches those JSON files directly from the CDN.

Upload worker
- POST /api/upload-url  (Bearer token)  ->  { panoId, key, url }
  url is a presigned PUT, valid 900s

CRUD worker  (Bearer token on all except reads/stats)
- GET    /api/panos                 ->  { panoIds }   (just IDs — no titles/thumbs)
- PUT    /api/panos/:id/config      ->  { etag }      requires If-Match (428 if missing, 412 if stale)
- DELETE /api/panos/:id             ->  204
- POST   /api/tours                 ->  { tourId }
- PUT    /api/tours/:id             ->  { etag }      (same If-Match rule)
- POST   /api/tours/:id/view        (anonymous)
- POST   /api/tours/:id/like        (needs identity)
- GET    /api/tours/:id/stats       ->  { views, likes }

Reads (no worker):  GET {cdn}/{key}  for manifest.json, config.json, tour.json, and tiles.

## Data model
- SceneConfig: { panoId, title, description?, initialView?: {yaw,pitch,fov}, hotspots: Hotspot[] }
- Hotspot:     { id, type: 'info' | 'link', yaw, pitch, title, body?, targetPanoId? }
               (a 'link' hotspot requires targetPanoId)
- TourDoc:     { tourId, title, scenes: [{ panoId, mapX?, mapY? }] }

## Viewer building blocks (already exist)
new PanoViewer(baseUrl).load(panoId) + setView + onRender; mountable UI:
controls, nav-arrows, info-hotspots (markdown panels), share (buttons + popover).

## 5 constraints that shape the UX
1. Upload = fire-and-poll. After PUTting the original, poll {cdn}/{panoId}/manifest.json
   until it returns 200 (manifest = the "ready" flag). Needs a "processing…" state; no callback/websocket.
2. Editing needs the ETag. To save config/tour you must send If-Match — so the editor
   loads the current JSON (capturing its ETag) and needs a CONFLICT state for 412.
3. Gallery has no metadata endpoint. GET /api/panos returns only IDs; to show titles/
   thumbnails, fetch each config.json from the CDN (or add a richer list endpoint).
4. Likes need an identity. Anonymous like ⇒ generate & send an X-Client-Id; views are free.
5. 2D floor-plan map is the one viewer feature NOT built yet. If the design includes it,
   that's net-new viewer work. Everything else (hotspots, tours, share) exists.

## Open decisions
- Dev read path: dev has no cdn.panote.dev custom domain yet; the SPA needs a per-env read base URL.
- SPA stack: Pages + Vite/TS is the default; React/Svelte fine if the design implies it.

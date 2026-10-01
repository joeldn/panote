// Hooks into the upload overlay (unit D3, plan 4.2 `/app/new`): the editor only links
// there. Paths are relative to the router's /app basename.

/** Upload a new pano and append it to this tour. */
export const addPanoPath = (tourId: string): string =>
  `/new?${new URLSearchParams({ tour: tourId }).toString()}`;

/** Replace a pano's image in place (same panoId, new tiles). */
export const replaceImagePath = (tourId: string, panoId: string): string =>
  `/new?${new URLSearchParams({ tour: tourId, replace: panoId }).toString()}`;

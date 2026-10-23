import type { TourPublishState, TourWithConfigsOk } from '@internal/contracts';

import { sameValue, type EditorDocs } from '../editor/model.js';

/**
 * What the preview shows: the tour as the editor holds it right now, unsaved edits
 * included, in the shape the admin API returns a saved tour in.
 */
export function previewData(docs: EditorDocs, publish: TourPublishState | null): TourWithConfigsOk {
  const configs: TourWithConfigsOk['configs'] = {};
  for (const [panoId, scene] of Object.entries(docs.scenes)) {
    if (scene.kind === 'missing') {
      configs[panoId] = { missing: true, deleting: scene.deleting, hasOriginal: false };
    } else if (scene.etag === null && sameValue(scene.base, scene.current)) {
      // Uploaded but never titled, and untouched: no Save writes its config, so visitors
      // don't get it either.
      configs[panoId] = { missing: true, deleting: false, hasOriginal: true };
    } else {
      configs[panoId] = { config: scene.current, etag: scene.etag ?? '' };
    }
  }
  return { tour: docs.tour.current, etag: docs.tour.etag, publish, configs };
}

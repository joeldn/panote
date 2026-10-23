import type { TourPublishState, TourWithConfigsOk } from '@internal/contracts';

import type { EditorDocs } from '../editor/model.js';

/**
 * What the preview shows: the tour as the editor holds it right now, unsaved edits
 * included, in the shape the admin API returns a saved tour in.
 */
export function previewData(docs: EditorDocs, publish: TourPublishState | null): TourWithConfigsOk {
  const configs: TourWithConfigsOk['configs'] = {};
  for (const [panoId, scene] of Object.entries(docs.scenes)) {
    configs[panoId] =
      scene.kind === 'config'
        ? { config: scene.current, etag: scene.etag ?? '' }
        : { missing: true, deleting: scene.deleting, hasOriginal: false };
  }
  return { tour: docs.tour.current, etag: docs.tour.etag, publish, configs };
}

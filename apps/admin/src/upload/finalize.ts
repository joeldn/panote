import { ConflictError, type AdminApi } from '@internal/web-kit';

const MAX_TITLE = 100;

/** "IMG_2041 town-hall.jpg" -> "IMG 2041 town-hall"; the fallback when nothing is left. */
export function titleFromFileName(name: string, fallback: string): string {
  const base = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, MAX_TITLE).trim() || fallback;
}

export class FinalizeError extends Error {
  override name = 'FinalizeError';
}

/**
 * Gives a freshly tiled pano its config (only if it has none) and appends it to
 * the tour under If-Match. Idempotent, so a retry or a resume after sign-in is safe.
 */
export async function addPanoToTour(
  api: Pick<AdminApi, 'getPano' | 'putPanoConfig' | 'getTour' | 'putTour'>,
  tourId: string,
  panoId: string,
  title: string,
): Promise<void> {
  const pano = await api.getPano(panoId);
  if (pano.status === 'not-found') {
    if (pano.deleting) throw new FinalizeError('This pano is being deleted.');
    await api.putPanoConfig(panoId, { title }, '*');
  }
  for (let attempt = 0; ; attempt++) {
    const got = await api.getTour(tourId);
    if (got.status !== 'ok') throw new FinalizeError('This tour no longer exists.');
    const { tour, etag } = got.data;
    if (tour.scenes.some((s) => s.panoId === panoId)) return;
    try {
      await api.putTour(tourId, { ...tour, scenes: [...tour.scenes, { panoId }] }, etag);
      return;
    } catch (e) {
      // Edited elsewhere in between: re-read and append to the newer tour.
      if (e instanceof ConflictError && attempt < 2) continue;
      throw e;
    }
  }
}

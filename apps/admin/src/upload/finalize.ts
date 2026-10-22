import { ApiError, ConflictError, MAX_TOUR_SCENES, type AdminApi } from '@internal/web-kit';

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

/** A finishing step failed with a message for the user; `retryable: false` = retry can't help. */
export class FinalizeError extends Error {
  override name = 'FinalizeError';
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
  }
}

export const TOUR_FULL_MESSAGE = 'This tour already has the maximum number of panos.';
const tourFull = () => new FinalizeError(TOUR_FULL_MESSAGE, false);

type TourApi = Pick<AdminApi, 'getTour'>;

/** The tour can't take all of `count` new panos, though it has room for `room`. */
export const tourRoomMessage = (room: number): string =>
  `This tour has room for ${room} more ${room === 1 ? 'pano' : 'panos'}. Choose fewer photos.`;

export const TOUR_FULL_PENDING_MESSAGE =
  'This tour will be full once the photos already uploading are in.';

/**
 * Refuses up front (before any upload) when the tour can't take `count` more panos,
 * on top of `reserved` ones already on their way into it (uploading or queued).
 */
export async function assertTourHasRoom(
  api: TourApi,
  tourId: string,
  count = 1,
  reserved = 0,
): Promise<void> {
  const got = await api.getTour(tourId);
  if (got.status !== 'ok') throw new FinalizeError('This tour no longer exists.', false);
  const free = MAX_TOUR_SCENES - got.data.tour.scenes.length;
  if (free <= 0) throw tourFull();
  const room = free - reserved;
  if (room <= 0) throw new FinalizeError(TOUR_FULL_PENDING_MESSAGE, false);
  if (count > room) throw new FinalizeError(tourRoomMessage(room), false);
}

/**
 * Gives a freshly tiled pano a config (create-only) and appends it to
 * the tour under If-Match. Idempotent, so a retry or a resume after sign-in is safe.
 */
export async function addPanoToTour(
  api: Pick<AdminApi, 'createPanoConfig' | 'getTour' | 'putTour'>,
  tourId: string,
  panoId: string,
  title: string,
): Promise<void> {
  try {
    // Create-only (If-None-Match: *): never overwrites a config written in between.
    await api.createPanoConfig(panoId, { title });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      throw new FinalizeError('This pano is being deleted.', false);
    }
    // 412 (ConflictError): it already has a config, from a retry or the editor. Fine.
    if (!(e instanceof ConflictError)) throw e;
  }
  for (let attempt = 0; ; attempt++) {
    const got = await api.getTour(tourId);
    if (got.status !== 'ok') throw new FinalizeError('This tour no longer exists.', false);
    const { tour, etag } = got.data;
    if (tour.scenes.some((s) => s.panoId === panoId)) return;
    if (tour.scenes.length >= MAX_TOUR_SCENES) throw tourFull();
    try {
      await api.putTour(tourId, { ...tour, scenes: [...tour.scenes, { panoId }] }, etag);
      return;
    } catch (e) {
      // Edited elsewhere in between: re-read and append to the newer tour.
      if (e instanceof ConflictError && attempt < 2) continue;
      // The tour schema caps scenes (MAX_TOUR_SCENES); a 400 here is that cap.
      if (e instanceof ApiError && e.status === 400) throw tourFull();
      throw e;
    }
  }
}

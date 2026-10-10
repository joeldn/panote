// After a deploy, a tab that loaded the old index.html asks for lazy chunks that no longer
// exist. One reload picks up the new build; the timestamp stops a reload loop when the
// failure isn't a stale build (offline, or a chunk that is really missing).

const KEY = 'panote:chunk-reload';
/** A second chunk failure within this window shows the error instead of reloading again. */
export const RELOAD_WINDOW_MS = 10_000;

/** Indirection so tests can observe the reload; jsdom's location.reload can't be spied. */
export const page = { reload: (): void => window.location.reload() };

const CHUNK_ERROR =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS|error loading dynamically imported module/i;

/** The ways browsers and Vite word a lazy chunk that failed to load. */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

/** Reloads the page unless it already did so very recently; true if it reloaded. */
export function reloadOnce(now: number = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // No storage, no loop guard: don't risk reloading forever.
    return false;
  }
  page.reload();
  return true;
}

/** Vite fires this when a dynamic import's preload fails; reload instead of throwing. */
export function reloadOnPreloadError(target: Window = window): () => void {
  const onError = (event: Event) => {
    if (reloadOnce()) event.preventDefault();
  };
  target.addEventListener('vite:preloadError', onError);
  return () => target.removeEventListener('vite:preloadError', onError);
}

// Anonymous like identity (X-Client-Id) and the tours this browser has liked.
const CLIENT_ID_KEY = 'panote_client_id';
const LIKES_KEY = 'panote_likes';

let memoryId: string | null = null;

/** A stable per-browser UUID; falls back to per-page memory when storage is blocked. */
export function clientId(): string {
  try {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    memoryId ??= crypto.randomUUID();
    return memoryId;
  }
}

function likedTours(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LIKES_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export const hasLiked = (tourId: string): boolean => likedTours().includes(tourId);

export function rememberLike(tourId: string): void {
  try {
    const liked = likedTours();
    if (!liked.includes(tourId))
      localStorage.setItem(LIKES_KEY, JSON.stringify([...liked, tourId]));
  } catch {
    // Storage blocked: the server still dedupes by X-Client-Id.
  }
}

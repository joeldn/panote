// "Current" badge (plan C16): the last tour opened in the editor, per browser.
const KEY = 'panote.currentTour';

export function readCurrentTour(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeCurrentTour(tourId: string): void {
  try {
    window.localStorage.setItem(KEY, tourId);
  } catch {
    // Storage blocked (private mode); the badge is cosmetic.
  }
}

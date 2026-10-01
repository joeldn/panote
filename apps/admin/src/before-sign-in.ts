import { useEffect, useRef } from 'react';

// Hooks that run right before the re-auth redirect leaves the page, so screens with
// unsaved work (the editor) can park it first, or stop the redirect if they can't.

export interface BeforeSignIn {
  /** Park state; return a message to stop the redirect and tell the user why. */
  prepare: () => string | null | void;
  /** The redirect is going ahead (e.g. disarm a beforeunload prompt). */
  proceed?: () => void;
  /** The redirect failed after `proceed` (e.g. re-arm that prompt). */
  cancel?: () => void;
}

const hooks = new Set<{ current: BeforeSignIn }>();

/**
 * Runs every hook; returns the first refusal (and leaves all guards armed), or null.
 * `force` (the user chose to continue anyway) still proceeds after a refusal.
 */
export function runBeforeSignIn({ force = false } = {}): string | null {
  let refusal: string | null = null;
  for (const hook of hooks) {
    try {
      refusal ??= hook.current.prepare() ?? null;
    } catch (e) {
      refusal ??= e instanceof Error ? e.message : 'Couldn’t prepare to sign in.';
    }
  }
  if (refusal && !force) return refusal;
  for (const hook of hooks) hook.current.proceed?.();
  return refusal;
}

/** The sign-in redirect didn't happen after all: undo every `proceed`. */
export function cancelBeforeSignIn(): void {
  for (const hook of hooks) hook.current.cancel?.();
}

export function useBeforeSignIn(hook: BeforeSignIn): void {
  const latest = useRef(hook);
  useEffect(() => {
    latest.current = hook;
  });
  useEffect(() => {
    hooks.add(latest);
    return () => {
      hooks.delete(latest);
    };
  }, []);
}

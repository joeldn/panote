import { useEffect, useRef } from 'react';

// Callbacks run right before the re-auth redirect leaves the page, so screens with
// unsaved work (the editor) can park it first. Errors in one never block sign-in.
const hooks = new Set<() => void>();

export function runBeforeSignIn(): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch (e) {
      console.error('before-sign-in hook failed', e);
    }
  }
}

export function useBeforeSignIn(cb: () => void): void {
  const latest = useRef(cb);
  useEffect(() => {
    latest.current = cb;
  });
  useEffect(() => {
    const hook = () => latest.current();
    hooks.add(hook);
    return () => {
      hooks.delete(hook);
    };
  }, []);
}

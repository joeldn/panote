import { useCallback, useEffect, useRef, useState } from 'react';

import { COPY_CONFIRM_MS } from '../constants.js';

export type CopyState = 'idle' | 'copied' | 'failed';

/** Clipboard write whose state flips back to idle after COPY_CONFIRM_MS. */
export function useCopy(): [CopyState, (text: string) => Promise<void>] {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string) => {
    let next: CopyState = 'copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'failed';
    }
    clearTimeout(timer.current);
    setState(next);
    timer.current = setTimeout(() => setState('idle'), COPY_CONFIRM_MS);
  }, []);

  return [state, copy];
}

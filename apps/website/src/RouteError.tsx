import { Button } from '@internal/ui';
import { useEffect, useRef, useState } from 'react';
import { useRouteError } from 'react-router';

import { canReload, isChunkLoadError, page, reloadOnce } from './chunk-reload.js';

/**
 * errorElement for the lazy Shell routes. A chunk that 404s after a deploy reloads the page
 * once; anything else, or a second failure straight after, shows a retry card. It reuses the
 * tour placeholder's styles, which are in the entry CSS, since the Shell's may not be.
 */
export function RouteError() {
  const error = useRouteError();
  // Decided once, without side effects: StrictMode renders twice, and a reload started from
  // the first render would make the second one show the retry card while the page reloads.
  const [reloading, setReloading] = useState(() => isChunkLoadError(error) && canReload());
  const reloaded = useRef(false);
  useEffect(() => {
    if (!reloading) {
      console.error('page failed to load', error);
      return;
    }
    // StrictMode runs effects twice too; the ref keeps it to one reload.
    if (reloaded.current) return;
    reloaded.current = true;
    // Only when storage refused the timestamp: with no loop guard, show the card instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!reloadOnce()) setReloading(false);
  }, [error, reloading]);
  if (reloading) return null;
  return (
    <div className="tour-page tour-unavailable">
      <title>panote</title>
      <div className="tour-unavailable__card" role="status">
        <h1 className="tour-unavailable__title">This page couldn&apos;t be loaded</h1>
        <p className="tour-unavailable__body">Check your connection and try again.</p>
        <Button size="sm" onClick={() => page.reload()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

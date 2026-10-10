import { Button } from '@internal/ui';
import { useEffect } from 'react';
import { useRouteError } from 'react-router';

import { isChunkLoadError, page, reloadOnce } from './chunk-reload.js';

/**
 * errorElement for the lazy Shell routes. A chunk that 404s after a deploy reloads the page
 * once; anything else, or a second failure straight after, shows a retry card. It reuses the
 * tour placeholder's styles, which are in the entry CSS, since the Shell's may not be.
 */
export function RouteError() {
  const error = useRouteError();
  const reloading = isChunkLoadError(error) && reloadOnce();
  useEffect(() => {
    if (!reloading) console.error('page failed to load', error);
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

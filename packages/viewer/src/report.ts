/**
 * Hand an error that has nowhere to propagate (a listener's, an event
 * handler's) to the host's error reporting, without throwing.
 */
export function report(err: unknown): void {
  if (typeof reportError === 'function') reportError(err);
  else console.error(err);
}

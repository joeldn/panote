export type BeaconSend = (url: string, body: string) => void;

/** sendBeacon (a text/plain string, no preflight), else a keepalive fetch without cookies. */
export const sendBeaconOrFetch: BeaconSend = (url, body) => {
  try {
    if (navigator.sendBeacon?.(url, body)) return;
  } catch {
    // Some browsers throw instead of returning false (e.g. over the queue quota).
  }
  globalThis
    .fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit' })
    .catch(() => {});
};

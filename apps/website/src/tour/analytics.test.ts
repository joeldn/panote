import { AnalyticsEventBatchSchema } from '@internal/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createViewerBeacon, sendBeaconOrFetch } from './analytics.js';

let visibility: DocumentVisibilityState;
let clock: number;
const sendBeacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null));

const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};
const sent = () =>
  sendBeacon.mock.calls.map(([url, body]) => ({
    url,
    body: AnalyticsEventBatchSchema.parse(JSON.parse(String(body))),
  }));
const beacon = (over: Partial<Parameters<typeof createViewerBeacon>[0]> = {}) =>
  createViewerBeacon({ baseUrl: '', tourId: 'tour-a', surface: 'page', now: () => clock, ...over });

beforeEach(() => {
  visibility = 'visible';
  clock = 1000;
  sendBeacon.mockClear().mockReturnValue(true);
  fetchMock.mockClear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'sendBeacon');
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('createViewerBeacon', () => {
  it('batches scene and hotspot events to /events after the flush delay', () => {
    const b = beacon({ surface: 'embed' });
    b.track({ type: 'scene', panoId: 'square' });
    b.track({ type: 'hotspot', panoId: 'square', hotspotId: 'i1' });
    expect(sendBeacon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(sent()).toEqual([
      {
        url: '/api/tours/tour-a/events',
        body: {
          events: [
            { type: 'scene', panoId: 'square', surface: 'embed' },
            { type: 'hotspot', panoId: 'square', hotspotId: 'i1', surface: 'embed' },
          ],
        },
      },
    ]);
  });

  it('honours an API base and splits at 20 events per request', () => {
    const b = beacon({ baseUrl: 'https://api.test/' });
    for (let i = 0; i < 25; i++) b.track({ type: 'scene', panoId: `p${i}` });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.url).toBe('https://api.test/api/tours/tour-a/events');
    expect(sent()[0]?.body.events).toHaveLength(20);
    b.flush();
    expect(sent()[1]?.body.events).toHaveLength(5);
  });

  it('drops hotspot ids outside [A-Za-z0-9_-]{1,64} without losing the batch', () => {
    const b = beacon();
    for (const hotspotId of ['bad id', 'a/b', '', 'x'.repeat(65), 'é']) {
      b.track({ type: 'hotspot', panoId: 'square', hotspotId });
    }
    b.track({ type: 'hotspot', panoId: 'square', hotspotId: 'Ok_id-9' });
    b.flush();
    expect(sent()[0]?.body.events).toEqual([
      { type: 'hotspot', panoId: 'square', hotspotId: 'Ok_id-9', surface: 'page' },
    ]);
  });

  it('sends nothing before attach and no dwell while never attached', () => {
    const b = beacon();
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    b.detach();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('sends the visible dwell on visibilitychange to hidden, then again per visible segment', () => {
    const b = beacon();
    b.attach();
    b.track({ type: 'scene', panoId: 'square' });
    clock += 4200;
    setVisibility('hidden');
    expect(sent()[0]?.body.events).toEqual([
      { type: 'scene', panoId: 'square', surface: 'page' },
      { type: 'dwell', ms: 4200, surface: 'page' },
    ]);
    // Hidden time doesn't count; pagehide after hidden adds nothing.
    clock += 60_000;
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    clock += 1500;
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()[1]?.body.events).toEqual([{ type: 'dwell', ms: 1500, surface: 'page' }]);
    b.detach();
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it('flushes dwell on detach (SPA navigation) and stops listening', () => {
    const b = beacon();
    b.attach();
    clock += 800;
    b.detach();
    expect(sent()[0]?.body.events).toEqual([{ type: 'dwell', ms: 800, surface: 'page' }]);
    setVisibility('hidden');
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('does not time dwell while attached in a hidden tab', () => {
    visibility = 'hidden';
    const b = beacon();
    b.attach();
    clock += 5000;
    b.detach();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('never sends unload-time requests', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const b = beacon();
    b.attach();
    expect(add.mock.calls.map(([type]) => type)).not.toContain('unload');
    expect(add.mock.calls.map(([type]) => type)).not.toContain('beforeunload');
    b.detach();
  });
});

describe('sendBeaconOrFetch', () => {
  it('uses sendBeacon with a plain string body', () => {
    sendBeaconOrFetch('/api/tours/t/events', '{"events":[]}');
    expect(sendBeacon).toHaveBeenCalledWith('/api/tours/t/events', '{"events":[]}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a cookieless keepalive fetch when sendBeacon refuses or is missing', () => {
    sendBeacon.mockReturnValueOnce(false);
    sendBeaconOrFetch('/u', 'a');
    Reflect.deleteProperty(navigator, 'sendBeacon');
    sendBeaconOrFetch('/u', 'b');
    expect(fetchMock.mock.calls).toEqual([
      ['/u', { method: 'POST', body: 'a', keepalive: true, credentials: 'omit' }],
      ['/u', { method: 'POST', body: 'b', keepalive: true, credentials: 'omit' }],
    ]);
  });
});

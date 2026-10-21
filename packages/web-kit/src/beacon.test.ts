import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendBeaconOrFetch } from './beacon.js';

const sendBeacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null));

beforeEach(() => {
  vi.stubGlobal('navigator', { sendBeacon });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sendBeacon.mockReset().mockReturnValue(true);
  fetchMock.mockClear();
});

describe('sendBeaconOrFetch', () => {
  it('uses sendBeacon with a plain string body', () => {
    sendBeaconOrFetch('/api/tours/t/events', '{"events":[]}');
    expect(sendBeacon).toHaveBeenCalledWith('/api/tours/t/events', '{"events":[]}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a cookieless keepalive fetch when sendBeacon refuses, throws or is missing', () => {
    sendBeacon.mockReturnValueOnce(false);
    sendBeaconOrFetch('/u', 'a');
    sendBeacon.mockImplementationOnce(() => {
      throw new TypeError('quota');
    });
    sendBeaconOrFetch('/u', 'b');
    vi.stubGlobal('navigator', {});
    sendBeaconOrFetch('/u', 'c');
    const init = (body: string) => ({ method: 'POST', body, keepalive: true, credentials: 'omit' });
    expect(fetchMock.mock.calls).toEqual([
      ['/u', init('a')],
      ['/u', init('b')],
      ['/u', init('c')],
    ]);
  });
});

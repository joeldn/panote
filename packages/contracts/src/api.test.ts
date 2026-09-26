import { describe, it, expect } from 'vitest';
import { PanoConfigOkSchema } from './api.js';

describe('PanoConfigOkSchema canonicalizes legacy out-of-range angles/fov', () => {
  it('parses a legacy doc (fov 90, hotspot yaw 5, hotspot pitch 2) to canonical values', () => {
    const r = PanoConfigOkSchema.parse({
      etag: 'abc',
      config: {
        panoId: 'p1',
        title: 'Hall',
        initialView: { yaw: 0, pitch: 0, fov: 90 },
        hotspots: [{ id: 'h1', type: 'info', yaw: 5, pitch: 2, title: 'Info' }],
      },
    });
    expect(r.config.initialView?.fov).toBe(80);
    expect(r.config.hotspots[0]?.yaw).toBeCloseTo(5 - 2 * Math.PI);
    expect(r.config.hotspots[0]?.pitch).toBeCloseTo(Math.PI / 2);
  });
});

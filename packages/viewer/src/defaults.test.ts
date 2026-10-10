import { describe, expect, it } from 'vitest';

import { VIEWER_DEFAULTS, mergeViewerOptions, resolveViewerOptions } from './defaults.js';

describe('VIEWER_DEFAULTS', () => {
  it('is frozen all the way down', () => {
    expect(Object.isFrozen(VIEWER_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(VIEWER_DEFAULTS.camera)).toBe(true);
    expect(Object.isFrozen(VIEWER_DEFAULTS.interaction.keyboard)).toBe(true);
    expect(Object.isFrozen(VIEWER_DEFAULTS.rendering.background)).toBe(true);
    expect(Object.isFrozen(VIEWER_DEFAULTS.network.retry)).toBe(true);
  });

  it('keeps the pitch limits just short of straight up and down', () => {
    expect(VIEWER_DEFAULTS.camera.maxPitch).toBeCloseTo(Math.PI / 2 - 0.001, 12);
    expect(VIEWER_DEFAULTS.camera.minPitch).toBe(-VIEWER_DEFAULTS.camera.maxPitch);
  });
});

describe('resolveViewerOptions', () => {
  it('is VIEWER_DEFAULTS for no options', () => {
    expect(resolveViewerOptions()).toEqual(VIEWER_DEFAULTS);
    expect(resolveViewerOptions({})).toEqual(VIEWER_DEFAULTS);
  });

  it('fills every unset field of a group from the defaults', () => {
    const r = resolveViewerOptions({
      camera: { maxFov: 90 },
      interaction: { keyboard: { panStepPx: 10 } },
      network: { retry: { maxAttempts: 5 } },
    });
    expect(r.camera).toEqual({ ...VIEWER_DEFAULTS.camera, maxFov: 90 });
    expect(r.interaction.keyboard).toEqual({ panStepPx: 10, zoomStep: 0.8 });
    expect(r.network.retry).toEqual({ maxAttempts: 5, baseDelayMs: 1000 });
    expect(r.rendering).toEqual(VIEWER_DEFAULTS.rendering);
  });

  it('reads autoRotate: true as { enabled: true }', () => {
    expect(resolveViewerOptions({ autoRotate: true }).autoRotate).toEqual({
      ...VIEWER_DEFAULTS.autoRotate,
      enabled: true,
    });
  });

  it('keeps false and arrays as given, and skips undefined', () => {
    const r = resolveViewerOptions({
      interaction: { keyboard: false, doubleClickZoom: false },
      rendering: { background: [1, 1, 1] },
      transition: {},
    });
    expect(r.interaction.keyboard).toBe(false);
    expect(r.interaction.doubleClickZoom).toBe(false);
    expect(r.rendering.background).toEqual([1, 1, 1]);
    expect(r.transition).toEqual(VIEWER_DEFAULTS.transition);
  });

  it('leaves out the options with no default', () => {
    const r = resolveViewerOptions({
      resolveSource: () => Promise.reject(new Error('unused')),
      initialView: { yaw: 1 },
      network: { fetch: globalThis.fetch, decode: (b) => createImageBitmap(b) },
    });
    expect(r).toEqual(VIEWER_DEFAULTS);
  });
});

describe('mergeViewerOptions', () => {
  it('merges groups key by key, later layers winning', () => {
    const merged = mergeViewerOptions(
      { camera: { minFov: 10, maxFov: 90 }, network: { requestInit: { mode: 'cors' } } },
      { camera: { maxFov: 100 }, network: { requestInit: { credentials: 'include' } } },
    );
    expect(merged).toEqual({
      camera: { minFov: 10, maxFov: 100 },
      network: { requestInit: { mode: 'cors', credentials: 'include' } },
    });
  });

  it('replaces what is not a plain object, and ignores undefined', () => {
    const fetchA = (() => {}) as unknown as typeof fetch;
    const fetchB = (() => {}) as unknown as typeof fetch;
    const merged = mergeViewerOptions(
      {
        interaction: { keyboard: { panStepPx: 10 }, label: 'a' },
        network: { fetch: fetchA },
        rendering: { background: [1, 1, 1] },
      },
      {
        interaction: { keyboard: false, label: undefined as unknown as string },
        network: { fetch: fetchB },
        rendering: { background: [0, 0, 0] },
      },
    );
    expect(merged.interaction).toEqual({ keyboard: false, label: 'a' });
    expect(merged.network?.fetch).toBe(fetchB);
    expect(merged.rendering?.background).toEqual([0, 0, 0]);
  });

  it('merges a boolean autoRotate with an object one', () => {
    expect(
      mergeViewerOptions({ autoRotate: { speed: 1, idleMs: 10 } }, { autoRotate: true }),
    ).toEqual({ autoRotate: { enabled: true, speed: 1, idleMs: 10 } });
  });

  it('does not touch its inputs', () => {
    const a = { camera: { minFov: 10 } };
    mergeViewerOptions(a, { camera: { minFov: 20 } });
    expect(a).toEqual({ camera: { minFov: 10 } });
  });
});

import type { PanoViewer } from '@panote/viewer';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PanoViewerContext } from '../viewer-context.js';
import { HotspotMarkers } from '../viewer/HotspotMarkers.js';
import { FALLBACK_ICON } from './names.js';

describe('HotspotMarkers icons', () => {
  afterEach(cleanup);

  it('renders a stored icon outside the subset as the fallback', () => {
    const viewer = { onRender: () => () => {}, project: () => ({ x: 0, y: 0, behind: false }) };
    render(
      <PanoViewerContext.Provider value={viewer as unknown as PanoViewer}>
        <HotspotMarkers
          hotspots={[
            { id: 'a', yaw: 0, pitch: 0, title: 'Anchor', icon: 'anchor' },
            { id: 'b', yaw: 0, pitch: 0, title: 'Bed', icon: 'bed' },
            { id: 'c', yaw: 0, pitch: 0, title: 'Plain' },
          ]}
          onOpen={() => {}}
        />
      </PanoViewerContext.Provider>,
    );
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('i')!;
    expect(icon('Anchor').className).toBe(`fa-solid fa-${FALLBACK_ICON}`);
    expect(icon('Bed').className).toBe('fa-solid fa-bed');
    expect(icon('Plain').className).toBe('fa-solid fa-info');
  });
});

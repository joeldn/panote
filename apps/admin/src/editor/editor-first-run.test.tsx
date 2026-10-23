import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import { resumeDraftWrites } from './draft.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(cleanup);

// Whole-editor renders, like Editor.test: slow under CI's coverage run.
vi.setConfig({ testTimeout: 15_000 });
configure({ asyncUtilTimeout: 5000 });

let server: FakeServer;
let viewers: FakeViewer[];
let create: ReturnType<typeof viewerFactory>['create'];

beforeEach(() => {
  localStorage.clear();
  resumeDraftWrites();
  server = new FakeServer();
  ({ create, viewers } = viewerFactory());
});

function openTab() {
  const r = renderAdmin('/app/t/t1', {
    auth: fakeAuth(),
    fetch: server.fetch,
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  return within(r.container);
}

const points = (ui: ReturnType<typeof within>) =>
  within(ui.getByRole('heading', { name: /^Points/ }).closest('section')!);
const tourCard = (ui: ReturnType<typeof within>) =>
  within(ui.getByRole('heading', { name: /^Tour/ }).closest('section')!);

describe('editor: first run', () => {
  it('an empty tour says to upload a pano, on the stage and in each panel', async () => {
    server.setTour({ tourId: 't1', title: 'New tour', scenes: [] });
    const ui = openTab();
    expect(await ui.findByRole('heading', { name: 'Start with a pano' })).toBeTruthy();
    expect(ui.getByText(/2:1 equirectangular JPG, PNG or WebP/)).toBeTruthy();
    expect(points(ui).getByRole('note').textContent).toBe(
      'Points sit on a pano. Add one to the tour first.',
    );
    expect(tourCard(ui).getByRole('note').textContent).toContain(
      'This tour has no panos yet. Add pano uploads a 360° photo',
    );
    const browse = vi.spyOn(HTMLInputElement.prototype, 'click');
    fireEvent.click(ui.getByRole('button', { name: 'Upload a pano' }));
    expect(browse.mock.contexts).toContain(screen.getByTestId('upload-picker'));
    browse.mockRestore();
  });

  it('one pano with no points says what Add point does, and that a second pano makes a tour', async () => {
    server.setTour({ tourId: 't1', title: 'New tour', scenes: [{ panoId: 'square' }] });
    server.setConfig('square', { title: 'Square', hotspots: [] });
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: New tour/ });
    expect(points(ui).getByRole('note').textContent).toContain(
      'No points on this pano yet. Press Add point',
    );
    expect(tourCard(ui).getByRole('note').textContent).toContain('Add a second pano');
    await waitFor(() => expect(viewers.length).toBeGreaterThan(0));
    fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
    expect(points(ui).getByRole('note').textContent).toContain(
      'Click the pano where the point goes',
    );
  });

  it('says nothing extra once a pano has points', async () => {
    server.setTour({
      tourId: 't1',
      title: 'Old town',
      scenes: [{ panoId: 'square' }, { panoId: 'church' }],
    });
    server.setConfig('square', {
      title: 'Square',
      hotspots: [{ id: 'i1', type: 'info', yaw: 0, pitch: 0, title: 'Fountain' }],
    });
    server.setConfig('church', { title: 'Church', hotspots: [] });
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    expect(points(ui).queryByRole('note')).toBeNull();
    expect(tourCard(ui).queryByRole('note')).toBeNull();
  });
});

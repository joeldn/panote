import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin, USER } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory } from '../__fixtures__/editor-server.js';
import { draftKey, resumeDraftWrites } from './draft.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Whole-editor round trips, like Editor.test: slow under CI's coverage run.
vi.setConfig({ testTimeout: 15_000 });

let server: FakeServer;
let create: ReturnType<typeof viewerFactory>['create'];

beforeEach(() => {
  localStorage.clear();
  resumeDraftWrites();
  server = new FakeServer();
  server.setTour({
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'square' }, { panoId: 'church', mapX: 0.4, mapY: 0.6 }, { panoId: 'hall' }],
  });
  server.setConfig('square', { title: 'Square', hotspots: [] });
  server.setConfig('church', { title: 'Church', hotspots: [] });
  server.setConfig('hall', { title: 'Hall', hotspots: [] });
  ({ create } = viewerFactory());
});

function openTab() {
  const r = renderAdmin('/app/t/t1', {
    auth: fakeAuth(),
    fetch: server.fetch,
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  return within(r.container);
}

const savedOrder = () =>
  (server.tour!.body.scenes as Array<{ panoId: string }>).map((s) => s.panoId);
const listOrder = (ui: ReturnType<typeof within>) =>
  ui
    .getAllByRole('button', { name: /^Move / })
    .map((b: HTMLElement) => /^Move (\w+)/.exec(b.getAttribute('aria-label') ?? '')?.[1]);

describe('editor: scene order', () => {
  it('moves a pano with the keyboard, keeps focus on it, and saves the new order', async () => {
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    const handle = ui.getByRole('button', { name: 'Move Hall, position 3 of 3' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(listOrder(ui)).toEqual(['Square', 'Hall', 'Church']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Hall, position 2 of 3');
    expect(ui.getByText('Hall moved to position 2 of 3.')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(listOrder(ui)).toEqual(['Hall', 'Square', 'Church']);

    // Autosaved like any other edit, so a reload doesn't lose it.
    window.dispatchEvent(new Event('pagehide'));
    const draft = JSON.parse(localStorage.getItem(draftKey(USER.sub, 't1')) ?? '{}') as {
      tour?: { doc: { scenes: Array<{ panoId: string }> } };
    };
    expect(draft.tour?.doc.scenes.map((s) => s.panoId)).toEqual(['hall', 'square', 'church']);

    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(savedOrder()).toEqual(['hall', 'square', 'church']);
    // A scene's map position goes with it.
    expect((server.tour!.body.scenes as unknown[])[2]).toEqual({
      panoId: 'church',
      mapX: 0.4,
      mapY: 0.6,
    });
  });

  it('moving it back leaves nothing to save', async () => {
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    fireEvent.keyDown(ui.getByRole('button', { name: /^Move Square/ }), { key: 'End' });
    expect(ui.getByRole('button', { name: 'Save' })).toBeTruthy();
    fireEvent.keyDown(ui.getByRole('button', { name: /^Move Square/ }), { key: 'Home' });
    await waitFor(() => expect(ui.queryByRole('button', { name: 'Save' })).toBeNull());
  });
});

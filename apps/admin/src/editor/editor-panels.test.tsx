import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import { resumeDraftWrites } from './draft.js';
import { panelStorageKey } from './panels.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  server.setTour({
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'square' }, { panoId: 'church' }],
    startPanoId: 'square',
  });
  server.setConfig('square', {
    title: 'Square',
    hotspots: [{ id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Fountain' }],
  });
  server.setConfig('church', { title: 'Church', hotspots: [] });
  ({ create, viewers } = viewerFactory());
});

async function openTab(path = '/app/t/t1') {
  const r = renderAdmin(path, {
    auth: fakeAuth(),
    fetch: server.fetch,
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  const ui = within(r.container);
  await ui.findByRole('button', { name: /Tour title: Old town/ });
  return ui;
}

type UI = Awaited<ReturnType<typeof openTab>>;

const side = (ui: UI) => within(ui.getByRole('complementary', { name: 'Editor panels' }));
const toggle = (ui: UI, name: RegExp) => side(ui).getByRole('button', { name });

/** A phone-width window: what `matchMedia` answers for the editor's phone query. */
const phoneWidth = () =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === '(max-width: 600px)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe('editor panels', () => {
  it('stacks Panos, This pano, Points and Map, each folding from its head', async () => {
    const ui = await openTab();
    const heads = side(ui)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent?.split(/\s/)[0]);
    expect(heads).toEqual(['Panos', 'This', 'Points', 'Map']);
    // Open, except the map, which starts folded to its head.
    for (const name of [/^Panos/, /^This pano/, /^Points/]) {
      expect(toggle(ui, name).getAttribute('aria-expanded')).toBe('true');
    }
    expect(toggle(ui, /^Map/).getAttribute('aria-expanded')).toBe('false');
    // Wide, there is no tab bar: every card has its place.
    expect(ui.queryByRole('tablist')).toBeNull();
  });

  it('remembers a folded card for the next visit', async () => {
    let ui = await openTab();
    fireEvent.click(toggle(ui, /^Points/));
    expect(toggle(ui, /^Points/).getAttribute('aria-expanded')).toBe('false');
    expect(side(ui).queryByRole('button', { name: 'Fountain' })).toBeNull();
    // Its Add point stays in the head.
    expect(ui.getByRole('button', { name: 'Add point' })).toBeTruthy();
    expect(localStorage.getItem(panelStorageKey('points'))).toBe('closed');

    cleanup();
    ui = await openTab();
    expect(toggle(ui, /^Points/).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle(ui, /^Points/));
    expect(side(ui).getByRole('button', { name: 'Fountain' })).toBeTruthy();
    expect(localStorage.getItem(panelStorageKey('points'))).toBe('open');
  });

  it('follows a card folded in another tab', async () => {
    const ui = await openTab();
    expect(toggle(ui, /^Points/).getAttribute('aria-expanded')).toBe('true');
    localStorage.setItem(panelStorageKey('points'), 'closed');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: panelStorageKey('points') }));
    });
    expect(toggle(ui, /^Points/).getAttribute('aria-expanded')).toBe('false');
  });

  it('still works with storage blocked, for the page', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const ui = await openTab();
      fireEvent.click(toggle(ui, /^Panos/));
      expect(toggle(ui, /^Panos/).getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle(ui, /^Panos/));
      expect(toggle(ui, /^Panos/).getAttribute('aria-expanded')).toBe('true');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('opens and folds a card with storage full: reads work, writes throw', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      const ui = await openTab();
      fireEvent.click(toggle(ui, /^Map/));
      expect(toggle(ui, /^Map/).getAttribute('aria-expanded')).toBe('true');
      expect(ui.getByRole('group', { name: 'Floor plan' })).toBeTruthy();
      fireEvent.click(toggle(ui, /^Map/));
      expect(toggle(ui, /^Map/).getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the notes for every card in view with Points folded', async () => {
    server.setTour({
      ...server.tour!.body,
      languages: { default: 'en', others: ['de'] },
    });
    localStorage.setItem(panelStorageKey('points'), 'closed');
    const ui = await openTab('/app/t/t1?lang=de');
    expect(toggle(ui, /^Points/).getAttribute('aria-expanded')).toBe('false');
    expect(side(ui).getByRole('note').textContent).toMatch(/Translating into Deutsch/);
  });

  it('returns focus to the point’s ⋯ button when Delete point is cancelled', async () => {
    const ui = await openTab();
    fireEvent.click(side(ui).getByRole('button', { name: 'Fountain' }));
    const more = ui.getByRole('button', { name: 'Point actions' });
    fireEvent.click(more);
    fireEvent.click(ui.getByRole('menuitem', { name: 'Delete point' }));
    const modal = await screen.findByRole('dialog', { name: 'Delete point?' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it('opens the folded Points card when a point is opened on the stage', async () => {
    localStorage.setItem(panelStorageKey('points'), 'closed');
    const ui = await openTab();
    await waitFor(() => expect(viewers.length).toBeGreaterThan(0));
    fireEvent.click(document.querySelector('[data-hotspot-id="i1"]')!);
    expect(await ui.findByRole('group', { name: 'Edit point Fountain' })).toBeTruthy();
    expect(toggle(ui, /^Points/).getAttribute('aria-expanded')).toBe('true');
  });

  it('says how connections work until the tour has one', async () => {
    const ui = await openTab();
    const panos = within(ui.getByRole('region', { name: /^Panos/ }));
    expect(panos.getByText(/Connections point/)).toBeTruthy();
    const church = within(ui.getByRole('group', { name: 'Connection to Church' }));
    fireEvent.click(church.getByRole('button', { name: /Aim here/ }));
    expect(panos.queryByText(/Connections point/)).toBeNull();
  });

  it('keeps a connection’s controls in reach of the keyboard', async () => {
    server.setConfig('square', {
      title: 'Square',
      hotspots: [
        { id: 'l1', type: 'link', yaw: 1, pitch: -0.4, title: 'Church', targetPanoId: 'church' },
      ],
    });
    const ui = await openTab();
    const church = within(ui.getByRole('group', { name: 'Connection to Church' }));
    for (const name of [/Nudge left/, /Nudge right/, /^Aim/, /Remove connection/]) {
      const b = church.getByRole('button', { name });
      // Quiet until pointed at (editor.css), never out of the tab order.
      expect(b.className).toContain('ed-conn__act');
      expect(b.tabIndex).toBe(0);
    }
  });

  it('shows the pano description’s purpose only while it is empty', async () => {
    const ui = await openTab();
    const field = within(ui.getByRole('region', { name: 'This pano' })).getByLabelText(
      /^Description/,
    ) as HTMLTextAreaElement;
    expect(field.placeholder).toBe('Visitors see it under About in the viewer.');
    expect(ui.queryByText('Visitors see it under About in the viewer.')).toBeNull();
  });

  it('turns the map on and off from the Map card, and saves it with the tour', async () => {
    const ui = await openTab();
    const map = within(ui.getByRole('region', { name: /^Map/ }));
    const show = map.getByRole('switch', { name: 'Show the map to visitors' });
    expect(show).toHaveProperty('checked', true);
    fireEvent.click(show);
    expect(show).toHaveProperty('checked', false);
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(server.tour!.body).toMatchObject({ settings: { showMap: false } });
  });
});

describe('editor panels on a phone', () => {
  it('are one sheet: a tab bar, and the card of the tab picked', async () => {
    phoneWidth();
    const ui = await openTab();
    const tabs = within(ui.getByRole('tablist', { name: 'Panels' }));
    expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Panos',
      'This pano',
      'Points',
      'Map',
    ]);
    const panos = ui.getByRole('tabpanel', { name: 'Panos' });
    expect(tabs.getByRole('tab', { name: 'Panos' }).getAttribute('aria-controls')).toBe(panos.id);
    // No folding here, and only one card shows.
    expect(side(ui).queryByRole('button', { name: /^Panos/, expanded: true })).toBeNull();
    expect(ui.getAllByRole('tabpanel')).toHaveLength(1);
    expect(side(ui).queryByRole('button', { name: 'Fountain' })).toBeNull();

    fireEvent.click(tabs.getByRole('tab', { name: 'Points' }));
    expect(ui.getByRole('tabpanel', { name: 'Points' })).toBeTruthy();
    expect(side(ui).getByRole('button', { name: 'Fountain' })).toBeTruthy();
    expect(ui.queryByRole('tabpanel', { name: 'Panos' })).toBeNull();

    // The map shows whole on its tab, though folded on a wide screen.
    fireEvent.click(tabs.getByRole('tab', { name: 'Map' }));
    expect(ui.getByRole('group', { name: 'Floor plan' })).toBeTruthy();
  });

  it('goes to the Points tab when a point is opened on the stage', async () => {
    phoneWidth();
    const ui = await openTab();
    await waitFor(() => expect(viewers.length).toBeGreaterThan(0));
    fireEvent.click(document.querySelector('[data-hotspot-id="i1"]')!);
    expect(await ui.findByRole('group', { name: 'Edit point Fountain' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Points' }).getAttribute('aria-selected')).toBe('true');
  });
});

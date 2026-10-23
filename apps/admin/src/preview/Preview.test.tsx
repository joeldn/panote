import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import { StageFactoryContext as EditorStage } from '../editor/stage-factory.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(() => {
  cleanup();
  // jsdom has no sendBeacon; drop the stub the analytics test puts on navigator.
  Reflect.deleteProperty(navigator, 'sendBeacon');
});

let server: FakeServer;
let viewers: FakeViewer[];
let create: ReturnType<typeof viewerFactory>['create'];

beforeEach(() => {
  server = new FakeServer();
  server.setTour({
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'square' }, { panoId: 'church' }],
    startPanoId: 'church',
    settings: { controls: 'top', showMap: false, showCompass: false, autoRotate: true },
  });
  server.setConfig('square', { title: 'Square', hotspots: [] });
  server.setConfig('church', {
    title: 'Church',
    hotspots: [
      { id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Altar', body: '**Old**' },
      { id: 'l1', type: 'link', yaw: 1, pitch: -0.4, title: 'Square', targetPanoId: 'square' },
    ],
  });
  ({ create, viewers } = viewerFactory());
});

function open(path = '/app/t/t1/preview', auth = fakeAuth()) {
  return renderAdmin(path, {
    auth,
    fetch: server.fetch,
    // The editor's seam too, for the way back.
    wrap: (tree) => (
      <EditorStage value={create}>
        <StageFactoryContext value={create}>{tree}</StageFactoryContext>
      </EditorStage>
    ),
  });
}

const shown = () => screen.findByRole('navigation', { name: 'Tour' });
const lastViewer = () => viewers[viewers.length - 1]!;

describe('owner preview', () => {
  it('loads the tour with its configs and opens on the start scene', async () => {
    open();
    const crumbs = await shown();
    expect(within(crumbs).getByText('Old town')).toBeTruthy();
    expect(within(crumbs).getByText('Church')).toBeTruthy();
    expect(server.requests.map((r) => r.path)).toEqual(['/api/admin/tours/t1?include=configs']);
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('church', { view: undefined }),
    );
    expect(screen.getByText('Preview')).toBeTruthy();
    // Full-screen: the app shell's bar isn't rendered behind it.
    expect(document.querySelector('.app-shell__bar')).toBeNull();
  });

  it('shows the ?lang= language, with a picker to switch', async () => {
    server.setTour({
      ...server.tour!.body,
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { title: 'Altstadt' } },
    });
    server.setConfig('church', {
      ...server.configs.get('church')!.body,
      i18n: { de: { title: 'Kirche' } },
    });
    open('/app/t/t1/preview?lang=de');
    const crumbs = await shown();
    expect(within(crumbs).getByText('Altstadt')).toBeTruthy();
    expect(within(crumbs).getByText('Kirche')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.change(picker, { target: { value: 'en' } });
    expect(await within(crumbs).findByText('Old town')).toBeTruthy();
  });

  it("shows the tour's and the pano's descriptions under About, in the ?lang= language", async () => {
    server.setTour({
      ...server.tour!.body,
      description: 'A walk round the old town.',
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { description: 'Ein Rundgang.' } },
    });
    server.setConfig('church', {
      ...server.configs.get('church')!.body,
      description: 'From 1702.',
    });
    open('/app/t/t1/preview?lang=de');
    await shown();
    fireEvent.click(screen.getByRole('button', { name: 'About this tour' }));
    const about = screen.getByRole('complementary', { name: 'About this tour' });
    expect(within(about).getByText('Ein Rundgang.')).toBeTruthy();
    // No German text for the pano: its default shows.
    expect(within(about).getByText('From 1702.')).toBeTruthy();
  });

  it('says so when the graphics memory runs out, rather than going black', async () => {
    open();
    await shown();
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalled());
    act(() => lastViewer().emit('context-lost'));
    expect(screen.getByRole('alert').textContent).toContain(
      'The viewer ran out of graphics memory.',
    );
  });

  it('honours the tour settings', async () => {
    open();
    await shown();
    expect(screen.getByRole('toolbar').className).toContain('pn-controls--top');
    expect(screen.queryByRole('button', { name: /map/i })).toBeNull();
    expect(document.querySelector('.pn-compass')).toBeNull();
    await waitFor(() => expect(lastViewer().setAutoRotate).toHaveBeenCalledWith(true));
  });

  it('shows the saved floor plan as visitors will see it', async () => {
    server.setTour({
      tourId: 't1',
      title: 'Old town',
      scenes: [
        { panoId: 'square', mapX: 0.2, mapY: 0.3 },
        { panoId: 'church', mapX: 0.6, mapY: 0.7 },
      ],
      startPanoId: 'church',
      plan: { id: 'plan-1', type: 'image/png', width: 640, height: 480 },
    });
    open();
    await shown();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const plan = screen.getByRole('group', { name: 'Floor plan' });
    expect(plan.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.panote.dev/pub/plans/t1/plan-1.png',
    );
    expect(within(plan).getByRole('button', { name: 'Church' }).getAttribute('aria-current')).toBe(
      'location',
    );
  });

  it('shows points and walks a link, sending no analytics, views or likes', async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    open();
    await shown();
    // The markers render before the stage hands its viewer to them; a click in between
    // opens the panel but has no viewer to report to. load() runs once it has.
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('church', { view: undefined }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Altar' }));
    expect(await screen.findByRole('complementary')).toBeTruthy();
    // The open is reported to the stage, as it is for visitors; Preview gives the
    // stage no onHotspotOpen, so it goes nowhere (nothing is sent, below).
    fireEvent.click(screen.getByRole('button', { name: 'Go to Square' }));
    await waitFor(() => expect(lastViewer().crossfade.mock.calls[0]?.[0]).toBe('square'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    // The admin GET is the only request; nothing reached the public API.
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/admin/tours/t1?include=configs',
    ]);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('links back to the editor in place of Edit', async () => {
    const { router } = open();
    await shown();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Back to editor' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1'));
    expect(await screen.findByRole('button', { name: /Tour title: Old town/ })).toBeTruthy();
  });

  it('works unpublished, without a Share button', async () => {
    open();
    await shown();
    expect(server.publish).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('offers the visitor share sheet once published', async () => {
    server.publish = {
      slug: 'old-town',
      visibility: 'public',
      publishedAt: '2026-10-01T00:00:00.000Z',
    };
    open();
    await shown();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('panote.dev/s/old-town')).toBeTruthy();
    expect(within(dialog).queryByText('Embed')).toBeNull();
  });

  it('shows the calm note when a scene’s tiles aren’t ready', async () => {
    const failing = viewerFactory();
    create = (...args) => {
      const v = failing.create(...args) as unknown as FakeViewer;
      v.crossfade.mockRejectedValue(new Error('manifest 404'));
      v.load.mockRejectedValue(new Error('manifest 404'));
      viewers.push(v);
      return v as never;
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open();
    expect(
      await screen.findByText(
        'This pano’s tiles aren’t ready yet. They appear once processing finishes.',
      ),
    ).toBeTruthy();
    // The chrome stays, so the owner can still get back to the editor.
    expect(screen.getByRole('link', { name: 'Back to editor' })).toBeTruthy();
  });

  it('shows not found for an unknown tour (or someone else’s)', async () => {
    server.tour = null;
    open();
    expect(await screen.findByRole('heading', { name: 'Tour not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to your tours' })).toBeTruthy();
  });

  it('asks to sign in again on a 401, then retries', async () => {
    server.unauthorized = true;
    open();
    expect(await screen.findByRole('heading', { name: 'Couldn’t load this tour' })).toBeTruthy();
    expect(screen.getByText(/Sign in again to load this tour/)).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'Your session has ended' })).toBeTruthy();
    server.unauthorized = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await shown()).toBeTruthy();
  });

  it('says so when the tour has no panos yet', async () => {
    server.setTour({ tourId: 't1', title: 'Old town', scenes: [] });
    open();
    expect(await screen.findByRole('heading', { name: 'Nothing to preview yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to editor' }).getAttribute('href')).toBe(
      '/app/t/t1',
    );
  });

  it('shows a loading state first', async () => {
    open();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await shown()).toBeTruthy();
  });
});

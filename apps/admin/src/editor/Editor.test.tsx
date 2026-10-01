import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin, USER } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import { draftKey } from './draft.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(cleanup);

let server: FakeServer;
let viewers: FakeViewer[];
let create: ReturnType<typeof viewerFactory>['create'];

beforeEach(() => {
  localStorage.clear();
  server = new FakeServer();
  server.setTour({
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'square' }, { panoId: 'church' }, { panoId: 'hall' }],
    startPanoId: 'square',
  });
  server.setConfig('square', {
    title: 'Square',
    hotspots: [
      { id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Fountain' },
      { id: 'l1', type: 'link', yaw: 1, pitch: -0.4, title: 'Church', targetPanoId: 'church' },
    ],
  });
  server.setConfig('church', { title: 'Church', hotspots: [] });
  ({ create, viewers } = viewerFactory());
});

/** One editor "tab": its own router, session and stage, sharing the one server. */
function openTab(path = '/app/t/t1', auth = fakeAuth()) {
  const r = renderAdmin(path, {
    auth,
    fetch: server.fetch,
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  return { ...r, ui: within(r.container) };
}

const loaded = (ui: ReturnType<typeof within>) =>
  ui.findByRole('button', { name: /Tour title: Old town/ });

async function rename(ui: ReturnType<typeof within>, label: RegExp, value: string) {
  fireEvent.click(await ui.findByRole('button', { name: label }));
  const input = ui.getByRole('textbox', { name: label.source.split(':')[0]!.replace(/\\/g, '') });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

const lastViewer = () => viewers[viewers.length - 1]!;
const DRAFT = draftKey(USER.sub, 't1');

/** True when a tab close would show the browser's "leave site?" prompt. */
const unloadPrompts = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('editor: load and missing panos', () => {
  it('loads the tour with every config in one request and marks a missing pano', async () => {
    const { ui } = openTab();
    await loaded(ui);
    expect(server.requests[0]?.path).toBe('/api/admin/tours/t1?include=configs');
    // The dashboard's "Current" badge (plan C16).
    expect(localStorage.getItem('panote.currentTour')).toBe('t1');
    expect(ui.getByText('Missing pano')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: /^Missing pano/ }));
    expect(await ui.findByRole('heading', { name: 'Missing pano' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Remove from tour' })).toBeTruthy();
    // Full-screen: the app shell's own bar isn't rendered (or focusable) behind it.
    expect(document.querySelector('.app-shell__bar')).toBeNull();
  });

  it('shows a not-found state for an unknown tour', async () => {
    server.tour = null;
    localStorage.setItem(DRAFT, '{"v":1}');
    const { ui } = openTab();
    expect(await ui.findByRole('heading', { name: 'Tour not found' })).toBeTruthy();
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });
});

describe('editor: save', () => {
  it('sends one PUT per dirty doc with If-Match, then publishes', async () => {
    const tourEtag = server.tour!.etag;
    const squareEtag = server.configs.get('square')!.etag;
    const { ui } = openTab();
    await loaded(ui);
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();
    await rename(ui, /Tour title: Old town/, 'Old town tour');
    await rename(ui, /Pano name: Square/, 'Main square');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');

    const writes = server.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'PUT /api/admin/panos/square/config',
      'PUT /api/admin/tours/t1',
      'POST /api/admin/tours/t1/publish',
    ]);
    expect(writes[0]?.ifMatch).toBe(`"${squareEtag}"`);
    expect(writes[1]?.ifMatch).toBe(`"${tourEtag}"`);
    expect(server.tour?.body.title).toBe('Old town tour');
    expect(server.configs.get('square')?.body.title).toBe('Main square');
    // First publish: the tour just went live by link.
    expect(ui.getByText(/now live for anyone with the link/)).toBeTruthy();

    // A second save only sends what changed since, with the new ETag.
    const tourEtagAfterFirst = server.tour!.etag;
    await rename(ui, /Tour title: Old town tour/, 'Again');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    const second = server.writes().slice(3);
    expect(second.map((w) => `${w.method} ${w.path}`)).toEqual([
      'PUT /api/admin/tours/t1',
      'POST /api/admin/tours/t1/publish',
    ]);
    expect(second[0]?.ifMatch).toBe(`"${tourEtagAfterFirst}"`);
  });

  it('shows the conflict UI when another tab saved first; overwrite retries with the fresh ETag', async () => {
    const a = openTab();
    const b = openTab();
    await loaded(a.ui);
    await loaded(b.ui);

    await rename(a.ui, /Tour title: Old town/, 'From tab A');
    fireEvent.click(a.ui.getByRole('button', { name: 'Save' }));
    await a.ui.findByText('Saved');
    const etagAfterA = server.tour!.etag;

    await rename(b.ui, /Tour title: Old town/, 'From tab B');
    fireEvent.click(b.ui.getByRole('button', { name: 'Save' }));
    const banner = await b.ui.findByRole('alert');
    expect(banner.textContent).toContain('This tour changed elsewhere — reload or overwrite.');
    expect(banner.textContent).toContain('Tour details');
    expect(server.tour?.body.title).toBe('From tab A');
    // The failed save does not publish.
    expect(server.writes().filter((w) => w.method === 'POST')).toHaveLength(1);

    fireEvent.click(within(banner).getByRole('button', { name: 'Overwrite' }));
    await b.ui.findByText('Saved');
    const puts = server.writes().filter((w) => w.method === 'PUT');
    expect(puts[puts.length - 1]?.ifMatch).toBe(`"${etagAfterA}"`);
    expect(puts.every((w) => w.ifMatch !== '*')).toBe(true);
    expect(server.tour?.body.title).toBe('From tab B');
    expect(b.ui.queryByRole('alert')).toBeNull();
  });

  it('reload takes the other tab’s version and drops local edits to that doc', async () => {
    const a = openTab();
    const b = openTab();
    await loaded(a.ui);
    await loaded(b.ui);
    await rename(a.ui, /Pano name: Square/, 'Plaza (A)');
    fireEvent.click(a.ui.getByRole('button', { name: 'Save' }));
    await a.ui.findByText('Saved');

    await rename(b.ui, /Pano name: Square/, 'Plaza (B)');
    fireEvent.click(b.ui.getByRole('button', { name: 'Save' }));
    const banner = await b.ui.findByRole('alert');
    expect(banner.textContent).toContain('Pano “Plaza (B)”');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(await b.ui.findByRole('button', { name: /Pano name: Plaza \(A\)/ })).toBeTruthy();
    expect(b.ui.queryByRole('alert')).toBeNull();
    expect(b.ui.getByText('Saved')).toBeTruthy();
  });

  it('a publish failure does not fail the save; slug lost links to the share link tab', async () => {
    server.publishScript = () =>
      new Response(JSON.stringify({ error: 'slug lost' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    const { ui, router } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Renamed');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(server.tour?.body.title).toBe('Renamed');
    expect(ui.getByText(/Another tour now uses this tour’s link/)).toBeTruthy();
    fireEvent.click(ui.getByRole('link', { name: 'Pick a new link' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1/share/link'));

    server.publishScript = () => new Response('', { status: 503 });
    await rename(ui, /Tour title: Renamed/, 'Renamed again');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(ui.getByText(/share link couldn’t be updated/)).toBeTruthy();
  });

  it('parks unsaved edits before a re-auth redirect and restores them on return', async () => {
    const auth = fakeAuth();
    const { ui } = openTab('/app/t/t1', auth);
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Unsaved title');
    expect(unloadPrompts()).toBe(true);
    server.unauthorized = true;
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    const signIn = await screen.findByRole('button', { name: /Google/ });
    fireEvent.click(signIn);
    await waitFor(() => expect(auth.signIn).toHaveBeenCalled());
    // The redirect itself must not trip the unsaved-changes prompt.
    expect(unloadPrompts()).toBe(false);
    const stored = JSON.parse(localStorage.getItem(DRAFT)!) as {
      tour: { etag: string; doc: { title: string } };
    };
    expect(stored.tour).toMatchObject({ etag: server.tour!.etag, doc: { title: 'Unsaved title' } });
    cleanup();

    server.unauthorized = false;
    const back = openTab();
    expect(await back.ui.findByRole('button', { name: /Tour title: Unsaved title/ })).toBeTruthy();
    expect(back.ui.getByText(/Restored your unsaved changes/)).toBeTruthy();
    expect(back.ui.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });

  it('creates a missing config create-only; a concurrent create gets the conflict UI', async () => {
    server.missing.set('hall', { deleting: false, hasOriginal: true });
    const a = openTab();
    const b = openTab();
    await loaded(a.ui);
    await loaded(b.ui);
    for (const t of [a, b]) {
      fireEvent.click(t.ui.getByRole('button', { name: /^Untitled pano/ }));
    }
    await rename(a.ui, /Pano name: Untitled pano/, 'Hall (A)');
    fireEvent.click(a.ui.getByRole('button', { name: 'Save' }));
    await a.ui.findByText('Saved');
    const create = server.writes().find((w) => w.path === '/api/admin/panos/hall/config')!;
    expect(create).toMatchObject({ ifNoneMatch: '*', ifMatch: null });
    const etagA = server.configs.get('hall')!.etag;

    await rename(b.ui, /Pano name: Untitled pano/, 'Hall (B)');
    fireEvent.click(b.ui.getByRole('button', { name: 'Save' }));
    const banner = await b.ui.findByRole('alert');
    expect(banner.textContent).toContain('changed elsewhere');
    // B's create did not overwrite A's.
    expect(server.configs.get('hall')!.body.title).toBe('Hall (A)');

    fireEvent.click(within(banner).getByRole('button', { name: 'Overwrite' }));
    await b.ui.findByText('Saved');
    const last = server
      .writes()
      .filter((w) => w.path === '/api/admin/panos/hall/config')
      .pop();
    expect(last).toMatchObject({ ifMatch: `"${etagA}"`, ifNoneMatch: null });
    expect(server.configs.get('hall')!.body.title).toBe('Hall (B)');
  });

  it('reloading a tour conflict loads configs for scenes added elsewhere and keeps local edits', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Pano name: Square/, 'Square (local)');
    await rename(ui, /Tour title: Old town/, 'Local title');
    // Another device adds a pano to the tour.
    server.setConfig('cellar', { title: 'Cellar', hotspots: [] });
    server.setTour({
      ...server.tour!.body,
      scenes: [...(server.tour!.body.scenes as object[]), { panoId: 'cellar' }],
    });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    const banner = await ui.findByRole('alert');
    expect(banner.textContent).toContain('Tour details');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(await ui.findByRole('button', { name: /^Cellar/ })).toBeTruthy();
    expect(ui.getByRole('button', { name: /Tour title: Old town/ })).toBeTruthy();
    // The square config saved fine before the conflict, so it is the server's now.
    expect(server.configs.get('square')!.body.title).toBe('Square (local)');
    fireEvent.click(ui.getByRole('button', { name: /^Cellar/ }));
    expect(await ui.findByRole('button', { name: /Pano name: Cellar/ })).toBeTruthy();
  });

  it('keeps local dirty configs when reloading a tour conflict', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Local title');
    server.brokenConfigs.add('square');
    await rename(ui, /Pano name: Square/, 'Square (unsaved)');
    server.setTour({ ...server.tour!.body, title: 'Remote title' });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    const alerts = await ui.findAllByRole('alert');
    const conflict = alerts.find((a) => a.textContent?.includes('changed elsewhere'))!;
    fireEvent.click(within(conflict).getByRole('button', { name: 'Reload' }));
    expect(await ui.findByRole('button', { name: /Tour title: Remote title/ })).toBeTruthy();
    expect(ui.getByRole('button', { name: /Pano name: Square \(unsaved\)/ })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('blocks Ctrl+S and the error banner retry while a conflict is open', async () => {
    const { ui } = openTab();
    await loaded(ui);
    server.brokenConfigs.add('square');
    await rename(ui, /Pano name: Square/, 'Square 2');
    await rename(ui, /Tour title: Old town/, 'Mine');
    server.setTour({ ...server.tour!.body, title: 'Theirs' });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText(/This tour changed elsewhere/);
    const retry = ui.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    const before = server.writes().length;
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.writes().length).toBe(before);
  });

  it('Ctrl+S commits a title that is still being typed', async () => {
    const { ui } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /Tour title: Old town/ }));
    const input = ui.getByRole('textbox', { name: 'Tour title' });
    input.focus();
    fireEvent.change(input, { target: { value: 'Typed, not entered' } });
    fireEvent.keyDown(document, { key: 's', metaKey: true });
    await ui.findByText('Saved');
    expect(server.tour!.body.title).toBe('Typed, not entered');
  });

  it('offers Try again on a publish that failed after a save', async () => {
    const scenes = [{ panoId: 'church', reason: 'not-ready' }];
    server.publishScript = () =>
      new Response(JSON.stringify({ error: 'scenes not publishable', scenes }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Renamed');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText(/Church \(still processing\)/);
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();
    server.publishScript = null;
    fireEvent.click(ui.getByRole('button', { name: 'Try again' }));
    expect(await ui.findByText(/now live for anyone with the link/)).toBeTruthy();
    expect(server.writes().filter((w) => w.method === 'POST')).toHaveLength(2);
    expect(server.writes().filter((w) => w.method === 'PUT')).toHaveLength(1);
  });

  it('warns instead of redirecting when the draft can’t be stored, then lets you continue', async () => {
    const auth = fakeAuth();
    const { ui } = openTab('/app/t/t1', auth);
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Unsaved title');
    server.unauthorized = true;
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      fireEvent.click(await screen.findByRole('button', { name: /Google/ }));
      const modal = screen.getByRole('dialog', { name: 'Your session has ended' });
      expect((await within(modal).findByRole('alert')).textContent).toContain(
        'couldn’t be kept while you sign in',
      );
      expect(auth.signIn).not.toHaveBeenCalled();
      expect(unloadPrompts()).toBe(true);
      fireEvent.click(within(modal).getByRole('button', { name: /Google/ }));
      await waitFor(() => expect(auth.signIn).toHaveBeenCalled());
    } finally {
      setItem.mockRestore();
    }
  });

  it('clears the parked draft after a successful save and sweeps drafts on sign-out', async () => {
    const auth = fakeAuth();
    localStorage.setItem(draftKey('google-oauth2|someone-else', 't9'), '{}');
    const { ui } = openTab('/app/t/t1', auth);
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Edited');
    localStorage.setItem(DRAFT, '{"v":1}');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(localStorage.getItem(DRAFT)).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: /^Account:/ }));
    fireEvent.click(ui.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(Object.keys(localStorage).filter((k) => k.startsWith('panote:editor-draft:'))).toEqual(
      [],
    );
  });

  it('drops a parked draft whose doc changed on the server meanwhile', async () => {
    localStorage.setItem(
      DRAFT,
      JSON.stringify({
        v: 1,
        savedAt: '2026-10-01T00:00:00Z',
        tour: { etag: 'stale', doc: { tourId: 't1', title: 'Old draft', scenes: [] } },
        configs: {},
      }),
    );
    const { ui } = openTab();
    await loaded(ui);
    expect(ui.getByText(/dropped because the tour details changed elsewhere/)).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('editor: points, connections, views and settings', () => {
  it('adds a point by clicking the pano and edits title, icon, size and media', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith('square'));
    fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
    lastViewer().pointAt = { yaw: -0.7, pitch: 0.3 };
    fireEvent.click(ui.getByText(/Click the pano to drop the point/).parentElement!);

    const panel = await ui.findByRole('group', { name: 'Edit point New point' });
    const p = within(panel);
    fireEvent.change(p.getByLabelText('Title'), { target: { value: 'Bell tower' } });
    fireEvent.change(p.getByLabelText(/Text/), { target: { value: '**Tall**' } });
    fireEvent.click(p.getByRole('radio', { name: 'church' }));
    fireEvent.focus(p.getByLabelText(/Size/));
    fireEvent.change(p.getByLabelText(/Size/), { target: { value: '2' } });
    expect(lastViewer().setView).toHaveBeenCalledWith({ yaw: -0.7, pitch: 0.3 });
    fireEvent.click(p.getByRole('radio', { name: 'Image' }));
    const url = p.getByLabelText('Media link');
    fireEvent.change(url, { target: { value: 'https://elsewhere.example/a.jpg' } });
    fireEvent.blur(url);
    expect((await p.findByRole('status')).textContent).toContain('isn’t on the panote CDN');
    fireEvent.change(url, { target: { value: 'https://cdn.panote.test/media/a.jpg' } });
    fireEvent.blur(url);
    await waitFor(() => expect(p.queryByRole('status')).toBeNull());
    fireEvent.change(url, { target: { value: 'not a url' } });
    fireEvent.blur(url);
    expect((await p.findByRole('alert')).textContent).toContain('https://');

    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    const saved = server.configs.get('square')!.body.hotspots as Array<Record<string, unknown>>;
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({
      type: 'info',
      yaw: -0.7,
      pitch: 0.3,
      title: 'Bell tower',
      body: '**Tall**',
      icon: 'church',
      size: 2,
      media: { kind: 'image', url: 'https://cdn.panote.test/media/a.jpg' },
    });
  });

  it('deletes a point through the confirm modal', async () => {
    const { ui } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getAllByRole('button', { name: 'Fountain' })[0]!);
    fireEvent.click(ui.getByRole('button', { name: 'Delete point' }));
    const modal = await screen.findByRole('dialog', { name: 'Delete point?' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Delete point' }));
    expect(ui.getByRole('heading', { name: /Points 0/ })).toBeTruthy();
  });

  it('aims, nudges and removes connections; sets start view, north and the entry pano', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await waitFor(() => expect(lastViewer().load).toHaveBeenCalledWith('square'));
    const church = within(ui.getByRole('group', { name: 'Connection to Church' }));
    expect(church.getByText('57°')).toBeTruthy();
    fireEvent.click(church.getByRole('button', { name: /Nudge right/ }));
    expect(church.getByText('62°')).toBeTruthy();
    lastViewer().view = { yaw: Math.PI / 2, pitch: -0.1, fov: 90 };
    fireEvent.click(church.getByRole('button', { name: /Aim/ }));
    expect(church.getByText('90°')).toBeTruthy();
    fireEvent.click(church.getByRole('button', { name: 'Remove connection to Church' }));
    expect(church.getByText('not connected')).toBeTruthy();
    fireEvent.click(church.getByRole('button', { name: /Aim here/ }));
    expect(church.getByText('90°')).toBeTruthy();

    fireEvent.click(ui.getByRole('button', { name: /Start here/ }));
    fireEvent.click(ui.getByRole('button', { name: /North is here/ }));
    fireEvent.click(ui.getByRole('button', { name: 'Start the tour at Church' }));

    fireEvent.click(ui.getByRole('button', { name: 'Tour settings' }));
    const settings = within(ui.getByRole('dialog', { name: 'Tour settings' }));
    fireEvent.click(settings.getByRole('radio', { name: 'Top' }));
    fireEvent.click(settings.getByRole('switch', { name: /Mini-map/ }));
    fireEvent.click(settings.getByRole('switch', { name: /Auto-rotate/ }));

    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    const square = server.configs.get('square')!.body;
    const link = (square.hotspots as Array<Record<string, unknown>>).find((h) => h.type === 'link');
    expect(link).toMatchObject({ targetPanoId: 'church', yaw: Math.PI / 2 });
    // fov is clamped to the contract's 15..80.
    expect(square.initialView).toEqual({ yaw: Math.PI / 2, pitch: -0.1, fov: 80 });
    expect(square.north).toBe(Math.PI / 2);
    expect(server.tour!.body).toMatchObject({
      startPanoId: 'church',
      settings: { controls: 'top', showMap: false, showCompass: true, autoRotate: true },
    });
  });

  it('removes a pano from the tour via the confirm modal', async () => {
    const { ui } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: 'Remove Church from tour' }));
    const modal = await screen.findByRole('dialog', { name: 'Remove pano from tour?' });
    expect(modal.textContent).toContain(
      '“Church” becomes a standalone pano. Its points and photo are kept.',
    );
    fireEvent.click(within(modal).getByRole('button', { name: 'Remove from tour' }));
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(server.tour!.body.scenes).toEqual([{ panoId: 'square' }, { panoId: 'hall' }]);
  });

  it('opens the share modal route over the editor', async () => {
    const { ui, router } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('link', { name: 'Share' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1/share/link'));
    expect(ui.getByRole('button', { name: /Tour title: Old town/ })).toBeTruthy();
  });

  it('asks before leaving with unsaved changes', async () => {
    const { ui, router } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Unsaved');
    fireEvent.click(ui.getByRole('link', { name: 'Your tours' }));
    const modal = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Stay' }));
    expect(router.state.location.pathname).toBe('/app/t/t1');
    // Share opens over the editor, so it doesn't count as leaving.
    fireEvent.click(ui.getByRole('link', { name: 'Share' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1/share/link'));
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(ui.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

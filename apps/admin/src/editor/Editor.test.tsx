import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin, USER } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import { FakeXhr } from '../__fixtures__/upload.js';
import { draftKey, resumeDraftWrites } from './draft.js';
import { PlanImageError } from './plan-image.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(cleanup);

// Each test here drives one or two whole editor tabs through load, edits and save round
// trips: about 0.3 s alone, but CI's Coverage job runs every package's suite at once under
// V8 coverage, and the first save tests of this file ran past 5 s there, on main as well
// (CI runs on 0c7574e and 68efe24). The work is the same; the runner is just that much slower.
vi.setConfig({ testTimeout: 15_000 });

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
    // The dashboard's "Current" badge (plan C16), written by a passive effect.
    await waitFor(() => expect(localStorage.getItem('panote.currentTour')).toBe('t1'));
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
    // Still unsaved, so still kept until Save.
    expect(localStorage.getItem(DRAFT)).toContain('Unsaved title');
    fireEvent.click(back.ui.getByRole('button', { name: 'Save' }));
    await back.ui.findByText('Saved');
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
    // Another device adds a pano to the tour, and renames it: a real conflict.
    server.setConfig('cellar', { title: 'Cellar', hotspots: [] });
    server.setTour({
      ...server.tour!.body,
      title: 'Their title',
      scenes: [...(server.tour!.body.scenes as object[]), { panoId: 'cellar' }],
    });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    const banner = await ui.findByRole('alert');
    expect(banner.textContent).toContain('Tour details');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(await ui.findByRole('button', { name: /^Cellar/ })).toBeTruthy();
    expect(ui.getByRole('button', { name: /Tour title: Their title/ })).toBeTruthy();
    // The square config saved fine before the conflict, so it is the server's now.
    expect(server.configs.get('square')!.body.title).toBe('Square (local)');
    fireEvent.click(ui.getByRole('button', { name: /^Cellar/ }));
    expect(await ui.findByRole('button', { name: /Pano name: Cellar/ })).toBeTruthy();
  });

  it('a save that only meets a scene appended meanwhile folds it in and saves, no conflict', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Local title');
    // An upload (this tab's or another's) appends a pano before this editor synced it.
    server.setConfig('cellar', { title: 'Cellar', hotspots: [] });
    server.setTour({
      ...server.tour!.body,
      scenes: [...(server.tour!.body.scenes as object[]), { panoId: 'cellar' }],
    });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(ui.queryByText(/changed elsewhere/)).toBeNull();
    expect(server.tour!.body).toMatchObject({
      title: 'Local title',
      scenes: [
        { panoId: 'square' },
        { panoId: 'church' },
        { panoId: 'hall' },
        { panoId: 'cellar' },
      ],
    });
    expect(ui.getByRole('button', { name: /^Cellar/ })).toBeTruthy();
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
    const scenes = [{ panoId: 'church', reason: 'deleting' }];
    server.publishScript = () =>
      new Response(JSON.stringify({ error: 'scenes not publishable', scenes }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Renamed');
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText(/Church \(being deleted\)/);
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
      // Continuing anyway also disarms the leave-page prompt.
      expect(unloadPrompts()).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  it('re-arms the leave-page prompt if the sign-in redirect fails', async () => {
    const auth = fakeAuth({
      signIn: vi.fn(async () => Promise.reject(new Error('popup blocked'))),
    });
    const { ui } = openTab('/app/t/t1', auth);
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Unsaved title');
    server.unauthorized = true;
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: /Google/ }));
    const modal = screen.getByRole('dialog', { name: 'Your session has ended' });
    expect((await within(modal).findByRole('alert')).textContent).toContain('popup blocked');
    expect(unloadPrompts()).toBe(true);
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

  it('signing out with unsaved edits leaves no draft behind, even after an autosave on the way out', async () => {
    const auth = fakeAuth();
    const { ui } = openTab('/app/t/t1', auth);
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Unsaved');
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(DRAFT)).toContain('Unsaved');
    fireEvent.click(ui.getByRole('button', { name: /^Account:/ }));
    fireEvent.click(ui.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(localStorage.getItem(DRAFT)).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });

  it("offers Delete account in the editor's account menu", async () => {
    const { ui } = openTab('/app/t/t1');
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /^Account:/ }));
    fireEvent.click(ui.getByRole('menuitem', { name: 'Delete account' }));
    expect(await screen.findByRole('dialog', { name: 'Delete your account?' })).toBeTruthy();
  });

  it('restores a draft whose doc changed on the server into the conflict banner, and Discard drops it', async () => {
    localStorage.setItem(
      DRAFT,
      JSON.stringify({
        v: 1,
        savedAt: new Date().toISOString(),
        tour: {
          etag: 'stale',
          doc: { tourId: 't1', title: 'Old draft', scenes: [{ panoId: 'square' }] },
        },
        configs: {},
      }),
    );
    const { ui } = openTab();
    expect(await ui.findByRole('button', { name: /Tour title: Old draft/ })).toBeTruthy();
    expect(ui.getByText(/Restored your unsaved changes/).textContent).toContain(
      'choose Reload or Overwrite above',
    );
    expect(ui.getByText(/This tour changed elsewhere/)).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Discard' }));
    await loaded(ui);
    expect(ui.queryByText(/This tour changed elsewhere/)).toBeNull();
    expect(ui.queryByText(/Restored your unsaved changes/)).toBeNull();
    expect(localStorage.getItem(DRAFT)).toBeNull();
    expect(server.writes()).toEqual([]);
  });

  it('autosaves edits when the tab is hidden and restores them in a new tab', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Kept title');
    window.dispatchEvent(new Event('pagehide'));
    cleanup();

    const back = openTab();
    expect(await back.ui.findByRole('button', { name: /Tour title: Kept title/ })).toBeTruthy();
    expect(back.ui.getByText(/Restored your unsaved changes/)).toBeTruthy();
  });
});

describe('editor: stop sharing', () => {
  it('says Save updates a live link, and a stopped tour stays offline on Save', async () => {
    server.publish = {
      slug: 'old-town',
      visibility: 'unlisted',
      publishedAt: '2026-10-01T00:00:00.000Z',
    };
    const { ui, router } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Renamed');
    const save = ui.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-describedby')).toBe('ed-save-hint');
    expect(ui.getByText('Saving updates the live link')).toBeTruthy();

    // Stop sharing from the share modal over the editor (edits stay unsaved).
    fireEvent.click(ui.getByRole('link', { name: 'Share' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1/share/link'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Privacy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));
    const confirm = screen.getByRole('dialog', { name: 'Stop sharing this tour?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Stop sharing' }));
    expect(await screen.findByText('This tour isn’t live yet')).toBeTruthy();
    expect(server.writes().at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/admin/tours/t1/publish',
    });
    // The editor follows: no "updates the live link" any more.
    expect(ui.queryByText('Saving updates the live link')).toBeNull();
    expect(ui.getByRole('button', { name: 'Save' }).getAttribute('aria-describedby')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1'));
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(server.tour?.body.title).toBe('Renamed');
    const publishCall = server.writes().at(-1);
    expect(publishCall).toMatchObject({ method: 'POST', body: { afterSave: true } });
    expect(server.publish).toBeNull();
    expect(ui.queryByText(/now live/)).toBeNull();
  });
});

describe('editor: points, connections, views and settings', () => {
  it('adds a point by clicking the pano and edits title, icon, size and media', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
    );
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
    // Linked from any https host, previewed inline as visitors see it.
    await waitFor(() =>
      expect(panel.querySelector('.ed-media__preview img')?.getAttribute('src')).toBe(
        'https://elsewhere.example/a.jpg',
      ),
    );
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
      media: { kind: 'image', url: 'https://elsewhere.example/a.jpg' },
    });
  });

  it('does not re-place the markers and chevrons on an unrelated editor render', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
    );
    await waitFor(() => expect(document.querySelector('[data-hotspot-id="i1"]')).not.toBeNull());
    await ui.findByRole('button', { name: 'Go to Church' });
    const { project } = lastViewer();
    project.mockClear();

    // Placing mode re-renders the editor without touching the points or links.
    fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
    await ui.findByText(/Click the pano to drop the point/);

    expect(project).not.toHaveBeenCalled();
  });

  it('draws no chevron for a connection back to the scene itself', async () => {
    server.setConfig('square', {
      title: 'Square',
      hotspots: [
        { id: 'l1', type: 'link', yaw: 1, pitch: -0.4, title: 'Church', targetPanoId: 'church' },
        { id: 'l2', type: 'link', yaw: 2, pitch: -0.4, title: 'Loop', targetPanoId: 'square' },
      ],
    });
    const { ui } = openTab();
    await loaded(ui);
    await ui.findByRole('button', { name: 'Go to Church' });
    expect(ui.queryByRole('button', { name: 'Go to Square' })).toBeNull();
  });

  describe('moving, duplicating and sizing points on the stage', () => {
    // The stage maps a pixel straight to a direction: x/100 is yaw, y/100 is pitch.
    const stageReady = async (ui: ReturnType<typeof within>) => {
      await loaded(ui);
      await waitFor(() =>
        expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
      );
      lastViewer().directionAtPixel.mockImplementation((x: number, y: number) => ({
        yaw: x / 100,
        pitch: y / 100,
      }));
    };
    const openFountain = (ui: ReturnType<typeof within>) => {
      fireEvent.click(ui.getAllByRole('button', { name: 'Fountain' })[0]!);
      return within(ui.getByRole('group', { name: 'Edit point Fountain' }));
    };
    const layer = (hint: RegExp) => screen.getByText(hint).parentElement!;
    const drag = (el: Element, from: [number, number], ...to: Array<[number, number]>) => {
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
      for (const [x, y] of to) fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y });
      const [x, y] = to.at(-1)!;
      fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y });
      fireEvent.click(el, { clientX: x, clientY: y });
    };
    const savedInfo = async (ui: ReturnType<typeof within>) => {
      fireEvent.click(ui.getByRole('button', { name: 'Save' }));
      await ui.findByText('Saved');
      const saved = server.configs.get('square')!.body.hotspots as Array<Record<string, unknown>>;
      return saved.filter((h) => h.type === 'info');
    };

    it('moves a point to a clicked spot', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(openFountain(ui).getByRole('button', { name: 'Move' }));
      fireEvent.click(layer(/Click the new spot/), { clientX: 150, clientY: 30 });
      expect(screen.queryByText(/Click the new spot/)).toBeNull();
      expect(await savedInfo(ui)).toEqual([
        { id: 'i1', type: 'info', yaw: 1.5, pitch: 0.3, title: 'Fountain' },
      ]);
    });

    it('moves a point by dragging it; the marker follows the pointer', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(openFountain(ui).getByRole('button', { name: 'Move' }));
      const el = layer(/drag the point there/);
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 20, clientY: 10 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 60, clientY: 10 });
      // Mid-drag the point is already there (and the doc dirty), from the next frame.
      await ui.findByRole('button', { name: 'Save' });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 80, clientY: -20 });
      fireEvent.pointerUp(el, { pointerId: 1, clientX: 80, clientY: -20 });
      fireEvent.click(el, { clientX: 80, clientY: -20 });
      expect(screen.queryByText(/drag the point there/)).toBeNull();
      expect(await savedInfo(ui)).toEqual([
        { id: 'i1', type: 'info', yaw: 0.8, pitch: -0.2, title: 'Fountain' },
      ]);
    });

    it('puts a point back where it was on Escape or Cancel move', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      const panel = openFountain(ui);
      fireEvent.click(panel.getByRole('button', { name: 'Move' }));
      const el = layer(/Click the new spot/);
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 20, clientY: 10 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 90, clientY: 40 });
      await ui.findByRole('button', { name: 'Save' });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByText(/Click the new spot/)).toBeNull();
      // Back where it was: nothing to save.
      expect(ui.getByText('Saved')).toBeTruthy();

      fireEvent.click(panel.getByRole('button', { name: 'Move' }));
      drag(layer(/Click the new spot/), [20, 10], [90, 40]);
      expect(ui.queryByText('Saved')).toBeNull();
      fireEvent.click(panel.getByRole('button', { name: 'Move' }));
      fireEvent.pointerMove(layer(/Click the new spot/), { pointerId: 2, clientX: 5, clientY: 5 });
      fireEvent.click(panel.getByRole('button', { name: 'Cancel move' }));
      expect(screen.queryByText(/Click the new spot/)).toBeNull();
      expect(await savedInfo(ui)).toEqual([
        { id: 'i1', type: 'info', yaw: 0.9, pitch: 0.4, title: 'Fountain' },
      ]);
    });

    it('duplicates a point a little round from it, content and all, and opens the copy', async () => {
      server.setConfig('square', {
        title: 'Square',
        hotspots: [
          {
            id: 'i1',
            type: 'info',
            yaw: 0.2,
            pitch: 0.1,
            title: 'Fountain',
            body: '**Old**',
            icon: 'star',
            size: 2,
          },
        ],
      });
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(openFountain(ui).getByRole('button', { name: 'Duplicate' }));
      const copy = within(ui.getByRole('group', { name: 'Edit point Fountain (copy)' }));
      expect((copy.getByLabelText(/Text/) as HTMLTextAreaElement).value).toBe('**Old**');
      expect(ui.getByRole('heading', { name: /Points 2/ })).toBeTruthy();
      const [original, dup] = await savedInfo(ui);
      expect(original).toMatchObject({ id: 'i1', yaw: 0.2 });
      expect(dup).toEqual({
        id: expect.not.stringMatching(/^i1$/),
        type: 'info',
        yaw: expect.closeTo(0.3),
        pitch: 0.1,
        title: 'Fountain (copy)',
        body: '**Old**',
        icon: 'star',
        size: 2,
      });
    });

    it('sizes a new point by dragging out from where it drops', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
      // 34 px out is twice a default marker's radius.
      drag(layer(/drag to size it/), [100, 50], [110, 50], [134, 50]);
      const panel = await ui.findByRole('group', { name: 'Edit point New point' });
      expect(within(panel).getByText('2.0×')).toBeTruthy();
      expect(screen.queryByText(/drag to size it/)).toBeNull();
      const [, placed] = await savedInfo(ui);
      expect(placed).toMatchObject({ yaw: 1, pitch: 0.5, title: 'New point', size: 2 });
    });

    it('keeps the default size for a wobbly click or tap', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
      // Past the drag threshold, but still inside a default marker.
      drag(layer(/drag to size it/), [100, 50], [106, 50], [110, 52]);
      const panel = await ui.findByRole('group', { name: 'Edit point New point' });
      expect(within(panel).getByText('1.0×')).toBeTruthy();
      const [, placed] = await savedInfo(ui);
      expect(placed).toEqual({
        id: expect.any(String),
        type: 'info',
        yaw: 1,
        pitch: 0.5,
        title: 'New point',
      });
    });

    it('undoes a drag the browser cancels: no point dropped, a moved one put back', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
      let el = layer(/drag to size it/);
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 100, clientY: 50 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 150, clientY: 50 });
      await ui.findByRole('heading', { name: /Points 2/ });
      fireEvent.pointerCancel(el, { pointerId: 1 });
      expect(ui.getByRole('heading', { name: /Points 1/ })).toBeTruthy();
      expect(screen.queryByText(/drag to size it/)).toBeNull();
      expect(ui.getByText('Saved')).toBeTruthy();

      fireEvent.click(openFountain(ui).getByRole('button', { name: 'Move' }));
      el = layer(/drag the point there/);
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 20, clientY: 10 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 90, clientY: 40 });
      await ui.findByRole('button', { name: 'Save' });
      fireEvent.pointerCancel(el, { pointerId: 1 });
      expect(screen.queryByText(/drag the point there/)).toBeNull();
      expect(ui.getByText('Saved')).toBeTruthy();
    });

    it('ends a move when another point is opened, so Esc no longer rolls it back', async () => {
      server.setConfig('square', {
        title: 'Square',
        hotspots: [
          { id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Fountain' },
          { id: 'i2', type: 'info', yaw: 1, pitch: 0, title: 'Bench' },
        ],
      });
      const { ui } = openTab();
      await stageReady(ui);
      const panel = openFountain(ui);
      fireEvent.click(panel.getByRole('button', { name: 'Move' }));
      const el = layer(/drag the point there/);
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 20, clientY: 10 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 90, clientY: 40 });
      await ui.findByRole('button', { name: 'Save' });
      // Open Bench from its marker, then Fountain again the same way.
      const marker = (id: string) => document.querySelector(`[data-hotspot-id="${id}"]`)!;
      fireEvent.click(marker('i2'));
      await ui.findByRole('group', { name: 'Edit point Bench' });
      fireEvent.click(marker('i1'));
      await ui.findByRole('group', { name: 'Edit point Fountain' });
      // Reopened: not moving any more, and Esc leaves the point where the drag put it.
      expect(ui.getByRole('button', { name: 'Move' })).toBeTruthy();
      expect(screen.queryByText(/drag the point there/)).toBeNull();
      fireEvent.keyDown(document, { key: 'Escape' });
      const [moved] = await savedInfo(ui);
      expect(moved).toMatchObject({ id: 'i1', yaw: 0.9, pitch: 0.4 });
    });

    it('drops a default-size point on a plain click, and none when Esc ends a sizing drag', async () => {
      const { ui } = openTab();
      await stageReady(ui);
      fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
      const el = layer(/drag to size it/);
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 100, clientY: 50 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 150, clientY: 50 });
      await ui.findByRole('heading', { name: /Points 2/ });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(ui.getByRole('heading', { name: /Points 1/ })).toBeTruthy();
      expect(ui.getByText('Saved')).toBeTruthy();

      fireEvent.click(ui.getByRole('button', { name: 'Add point' }));
      // A wobble under the drag threshold is still a click.
      drag(layer(/drag to size it/), [100, 50], [102, 51]);
      await ui.findByRole('group', { name: 'Edit point New point' });
      const [, placed] = await savedInfo(ui);
      expect(placed).toEqual({
        id: expect.any(String),
        type: 'info',
        yaw: 1.02,
        pitch: 0.51,
        title: 'New point',
      });
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
    await waitFor(() =>
      expect(lastViewer().load).toHaveBeenCalledWith('square', { view: undefined }),
    );
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

  it('edits the tour description in the settings and saves it trimmed', async () => {
    server.setTour({ ...server.tour!.body, description: 'Old town at dusk' });
    const { ui } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: 'Tour settings' }));
    const settings = within(ui.getByRole('dialog', { name: 'Tour settings' }));
    const field = settings.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    expect(field.value).toBe('Old town at dusk');
    fireEvent.change(field, { target: { value: 'Three squares and a harbour. ' } });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect(server.tour!.body.description).toBe('Three squares and a harbour.');
  });

  it('reloads a tour stored with a blank description as having none', async () => {
    const { ui } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Mine');
    // Another writer, through the raw API, stores an empty description.
    server.setTour({ ...server.tour!.body, description: '' });
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    const banner = await ui.findByRole('alert');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    await ui.findByText('Saved');
    fireEvent.click(ui.getByRole('button', { name: 'Tour settings' }));
    const settings = within(ui.getByRole('dialog', { name: 'Tour settings' }));
    const field = settings.getByRole('textbox', { name: 'Description' });
    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.change(field, { target: { value: '' } });
    // Back to blank: nothing to save.
    expect(ui.getByText('Saved')).toBeTruthy();
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();
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
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(DRAFT)).toContain('Unsaved');
    // Share opens over the editor, so it doesn't count as leaving.
    fireEvent.click(ui.getByRole('link', { name: 'Share' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/t1/share/link'));
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(ui.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('drops the autosaved draft when you leave without saving', async () => {
    const { ui, router } = openTab();
    await loaded(ui);
    await rename(ui, /Tour title: Old town/, 'Unsaved');
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(DRAFT)).toContain('Unsaved');
    fireEvent.click(ui.getByRole('link', { name: 'Your tours' }));
    const modal = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/app/t/t1'));
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });
});

describe('editor: map', () => {
  const tourPut = () =>
    server.writes().find((w) => w.method === 'PUT' && w.path === '/api/admin/tours/t1');

  it('places the open pano on the plan from the keyboard, and saves it with the tour', async () => {
    const { ui } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /^Map/ }));
    fireEvent.click(ui.getByRole('button', { name: 'Place on map' }));
    const dot = ui.getByRole('button', { name: /^Square, 50% across, 50% down/ });
    await waitFor(() => expect(document.activeElement).toBe(dot));
    fireEvent.keyDown(dot, { key: 'ArrowRight', shiftKey: true });
    expect(ui.getByRole('button', { name: /^Square, 55% across, 50% down/ })).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect((tourPut()?.body as { scenes: unknown[] }).scenes).toEqual([
      { panoId: 'square', mapX: 0.55, mapY: 0.5 },
      { panoId: 'church' },
      { panoId: 'hall' },
    ]);
    // Taking it off the map is another tour edit.
    fireEvent.click(ui.getByRole('button', { name: 'Remove from map' }));
    expect(ui.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('suggests positions for the unplaced panos from their links, as one tour edit', async () => {
    server.setTour({
      tourId: 't1',
      title: 'Old town',
      scenes: [
        { panoId: 'square', mapX: 0.2, mapY: 0.5 },
        { panoId: 'church' },
        { panoId: 'hall' },
      ],
      startPanoId: 'square',
    });
    // The square's north is set, and its link to the church points due east.
    server.setConfig('square', {
      title: 'Square',
      north: 0.3,
      hotspots: [
        {
          id: 'l1',
          type: 'link',
          yaw: 0.3 + Math.PI / 2,
          pitch: -0.4,
          title: 'Church',
          targetPanoId: 'church',
        },
      ],
    });
    const { ui } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /^Map/ }));
    expect(ui.queryByRole('button', { name: /^Church,/ })).toBeNull();
    fireEvent.click(ui.getByRole('button', { name: 'Suggest positions' }));
    const status = ui.getByRole('status');
    expect(status.textContent).toBe('Placed 2 panos, 1 from their links. Drag any that are off.');
    const church = ui.getByRole('button', { name: /^Church, \d+% across, 50% down/ });
    expect(parseFloat(church.style.left)).toBeGreaterThan(20);
    expect(ui.getByRole('button', { name: /^Missing pano,/ })).toBeTruthy();
    expect(ui.getByRole('button', { name: /^Square, 20% across, 50% down/ })).toBeTruthy();
    expect(ui.getByRole('button', { name: /^Map/ }).textContent).toContain('3 of 3 placed');
    expect(ui.getByRole('button', { name: 'Suggest positions' })).toHaveProperty('disabled', true);
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    // A save changes no position: the line stays. A move makes it stale.
    expect(status.textContent).toContain('Placed 2 panos');
    fireEvent.keyDown(church, { key: 'ArrowDown' });
    expect(status.textContent).toBe('');
    const scenes = (tourPut()?.body as { scenes: { panoId: string; mapX?: number }[] }).scenes;
    expect(scenes[0]).toEqual({ panoId: 'square', mapX: 0.2, mapY: 0.5 });
    expect(scenes.every((s) => s.mapX !== undefined)).toBe(true);
  });

  it('a click on a dot opens that pano', async () => {
    server.setTour({
      tourId: 't1',
      title: 'Old town',
      scenes: [
        { panoId: 'square', mapX: 0.2, mapY: 0.2 },
        { panoId: 'church', mapX: 0.7, mapY: 0.6 },
      ],
      startPanoId: 'square',
    });
    const { ui, router } = openTab();
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /^Map/ }));
    fireEvent.click(ui.getByRole('button', { name: /^Church, 70% across/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?pano=church'));
  });

  it('adds a plan image: redrawn, uploaded to its own key, then saved with the tour', async () => {
    const prepared = new Blob(['webp'], { type: 'image/webp' });
    const preparePlan = vi.fn(async () => ({
      blob: prepared,
      type: 'image/webp' as const,
      width: 1200,
      height: 600,
    }));
    server.intercept = (r) =>
      r.path === '/api/upload-url'
        ? new Response(
            JSON.stringify({
              planId: 'plan-9',
              key: 'pub/plans/t1/plan-9.webp',
              url: 'https://r2.test/put?sig',
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : undefined;
    FakeXhr.all = [];
    const r = renderAdmin('/app/t/t1', {
      fetch: server.fetch,
      upload: { preparePlan, createXhr: () => new FakeXhr() },
      wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
    });
    const ui = within(r.container);
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /^Map/ }));
    const file = new File(['raw'], 'plan.jpg', { type: 'image/jpeg' });
    fireEvent.change(ui.getByTestId('plan-input'), { target: { files: [file] } });
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(server.requests.find((q) => q.path === '/api/upload-url')?.body).toEqual({
      kind: 'plan',
      tourId: 't1',
      contentType: 'image/webp',
      size: prepared.size,
    });
    FakeXhr.last.respond(200);
    await waitFor(() =>
      expect(r.container.querySelector('.ed-map__img')?.getAttribute('src')).toBe(
        'https://cdn.panote.dev/pub/plans/t1/plan-9.webp',
      ),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    await ui.findByText('Saved');
    expect((tourPut()?.body as { plan: unknown }).plan).toEqual({
      id: 'plan-9',
      type: 'image/webp',
      width: 1200,
      height: 600,
    });
  });

  it('says why an image can’t be used, and saves nothing', async () => {
    const preparePlan = vi.fn(async () => {
      throw new PlanImageError('Use a JPG, PNG or WebP image.');
    });
    const r = renderAdmin('/app/t/t1', {
      fetch: server.fetch,
      upload: { preparePlan },
      wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
    });
    const ui = within(r.container);
    await loaded(ui);
    fireEvent.click(ui.getByRole('button', { name: /^Map/ }));
    fireEvent.change(ui.getByTestId('plan-input'), {
      target: { files: [new File(['x'], 'plan.gif', { type: 'image/gif' })] },
    });
    expect((await ui.findByRole('alert')).textContent).toBe('Use a JPG, PNG or WebP image.');
    expect(server.requests.some((q) => q.path === '/api/upload-url')).toBe(false);
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

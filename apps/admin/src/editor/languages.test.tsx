import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MAX_SCENE_TRANSLATION_CHARS } from '@internal/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory } from '../__fixtures__/editor-server.js';
import { editorReducer, fromServer, setTranslation, type EditorDocs } from './model.js';
import { StageFactoryContext } from './stage-factory.js';

afterEach(cleanup);

let server: FakeServer;
let create: ReturnType<typeof viewerFactory>['create'];

beforeEach(() => {
  localStorage.clear();
  server = new FakeServer();
  server.setTour({
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'square' }, { panoId: 'church' }],
    startPanoId: 'square',
  });
  server.setConfig('square', {
    title: 'Square',
    hotspots: [
      { id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Fountain', body: 'Old water' },
    ],
  });
  server.setConfig('church', { title: 'Church', hotspots: [] });
  ({ create } = viewerFactory());
});

function openTab(path = '/app/t/t1') {
  const r = renderAdmin(path, {
    auth: fakeAuth(),
    fetch: server.fetch,
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  return within(r.container);
}

type UI = ReturnType<typeof openTab>;

/** The language menu, opened if it isn't already. */
const openMenu = async (ui: UI) => {
  const open = ui.queryByRole('dialog', { name: 'Languages' });
  if (open) return open;
  fireEvent.click(await ui.findByRole('button', { name: /^Language:/ }));
  return ui.getByRole('dialog', { name: 'Languages' });
};

async function addLanguage(ui: UI, tag: string) {
  const menu = await openMenu(ui);
  fireEvent.change(within(menu).getByLabelText('Add a language'), { target: { value: tag } });
  fireEvent.click(within(menu).getByRole('button', { name: 'Add' }));
  return menu;
}

async function editInline(ui: UI, label: RegExp, value: string) {
  fireEvent.click(await ui.findByRole('button', { name: label }));
  const input = ui.getByRole('textbox', { name: label.source.split(':')[0]!.replace(/\\/g, '') });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

const save = async (ui: UI) => {
  fireEvent.click(ui.getByRole('button', { name: 'Save' }));
  await ui.findByText('Saved');
};

describe('editor: languages', () => {
  it('adds a language, translates titles and a point, and saves through If-Match', async () => {
    const tourEtag = server.tour!.etag;
    const squareEtag = server.configs.get('square')!.etag;
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    expect(ui.getByRole('button', { name: 'Language: English' })).toBeTruthy();

    const menu = await addLanguage(ui, 'de');
    // Switched straight to editing the new language.
    expect(within(menu).getByRole('button', { name: 'Deutsch' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(ui.getByRole('button', { name: 'Language: Deutsch' })).toBeTruthy();
    expect(ui.getByRole('note').textContent).toMatch(/Translating into Deutsch/);

    // Untranslated fields show the default text as a placeholder.
    const title = ui.getByRole('button', { name: /Tour title: Old town/ });
    expect(title.className).toContain('ed-inline--placeholder');
    await editInline(ui, /Tour title: Old town/, 'Altstadt');
    await editInline(ui, /Pano name: Square/, 'Platz');

    fireEvent.click(ui.getAllByRole('button', { name: 'Fountain' })[0]!);
    const point = ui.getByRole('group', { name: 'Edit point Fountain' });
    const pointTitle = within(point).getByLabelText(/^Title/) as HTMLInputElement;
    expect(pointTitle.value).toBe('');
    expect(pointTitle.placeholder).toBe('Fountain');
    fireEvent.change(pointTitle, { target: { value: 'Brunnen' } });
    const body = within(point).getByLabelText(/^Text/) as HTMLTextAreaElement;
    expect(body.placeholder).toBe('Old water');
    fireEvent.change(body, { target: { value: 'Altes Wasser' } });

    await save(ui);
    const writes = server.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'PUT /api/admin/panos/square/config?tourId=t1',
      'PUT /api/admin/tours/t1',
      'POST /api/admin/tours/t1/publish',
    ]);
    expect(writes[0]?.ifMatch).toBe(`"${squareEtag}"`);
    expect(writes[1]?.ifMatch).toBe(`"${tourEtag}"`);
    // The default-language text is untouched.
    expect(server.tour?.body).toMatchObject({
      title: 'Old town',
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { title: 'Altstadt' } },
    });
    const square = server.configs.get('square')!.body as Record<string, unknown>;
    expect(square).toMatchObject({ title: 'Square', i18n: { de: { title: 'Platz' } } });
    expect((square.hotspots as unknown[])[0]).toMatchObject({
      title: 'Fountain',
      body: 'Old water',
      i18n: { de: { title: 'Brunnen', body: 'Altes Wasser' } },
    });

    // Back in the default language, the default text is edited as before.
    fireEvent.click(within(await openMenu(ui)).getByRole('button', { name: /English/ }));
    expect(ui.getByRole('button', { name: /Tour title: Old town/ }).className).not.toContain(
      'ed-inline--placeholder',
    );
  });

  it("edits the pano's description, and its translation with the default as placeholder", async () => {
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    const pano = ui.getByRole('group', { name: 'This pano' });
    const field = () => within(pano).getByLabelText(/^Description/) as HTMLTextAreaElement;
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: 'Market days:\nTue and Sat ' } });
    // Kept as typed until blur, stored trimmed.
    expect(field().value).toBe('Market days:\nTue and Sat ');
    fireEvent.blur(field());
    expect(field().value).toBe('Market days:\nTue and Sat');

    await addLanguage(ui, 'de');
    expect(field().value).toBe('');
    expect(field().placeholder).toBe('Market days:\nTue and Sat');
    fireEvent.change(field(), { target: { value: 'Markttage' } });

    await save(ui);
    const square = server.configs.get('square')!.body as Record<string, unknown>;
    expect(square).toMatchObject({
      description: 'Market days:\nTue and Sat',
      i18n: { de: { description: 'Markttage' } },
    });
  });

  it('refuses a malformed custom language code', async () => {
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    const menu = await openMenu(ui);
    fireEvent.change(within(menu).getByLabelText('Add a language'), {
      target: { value: '__other' },
    });
    fireEvent.change(within(menu).getByLabelText('Language code'), {
      target: { value: 'Klingon!' },
    });
    fireEvent.click(within(menu).getByRole('button', { name: 'Add' }));
    expect(within(menu).getByRole('alert').textContent).toMatch(/language code/);
    fireEvent.change(within(menu).getByLabelText('Language code'), { target: { value: 'cy' } });
    fireEvent.click(within(menu).getByRole('button', { name: 'Add' }));
    expect(within(menu).queryByRole('alert')).toBeNull();
    expect(within(menu).getByRole('button', { name: /^Cymraeg$/i })).toBeTruthy();
  });

  it("removing a language asks first, then drops the tour's strings and keeps the panos'", async () => {
    server.setTour({
      ...server.tour!.body,
      languages: { default: 'en', others: ['de', 'fr'] },
      i18n: { de: { title: 'Altstadt' }, fr: { title: 'Vieille ville' } },
    });
    server.setConfig('square', {
      title: 'Square',
      i18n: { de: { title: 'Platz' } },
      hotspots: [
        {
          id: 'i1',
          type: 'info',
          yaw: 0.2,
          pitch: 0.1,
          title: 'Fountain',
          i18n: { de: { title: 'Brunnen' }, fr: { title: 'Fontaine' } },
        },
      ],
    });
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    const menu = await openMenu(ui);
    fireEvent.click(within(menu).getByRole('button', { name: 'Deutsch' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Remove Deutsch' }));
    const confirm = screen.getByRole('dialog', { name: 'Remove language?' });
    // Cancel keeps everything.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(ui.queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.click(within(menu).getByRole('button', { name: 'Remove Deutsch' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Remove language?' })).getByRole('button', {
        name: 'Remove language',
      }),
    );
    // Was editing German: back to the default.
    await waitFor(() => expect(ui.getByRole('button', { name: 'Language: English' })).toBeTruthy());
    await save(ui);
    expect(server.tour?.body).toMatchObject({
      languages: { default: 'en', others: ['fr'] },
      i18n: { fr: { title: 'Vieille ville' } },
    });
    // Only the tour was saved: a pano may be in other tours that keep German.
    expect(server.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      'PUT /api/admin/tours/t1',
      'POST /api/admin/tours/t1/publish',
    ]);
    const square = server.configs.get('square')!.body as Record<string, unknown>;
    expect(square).toMatchObject({ i18n: { de: { title: 'Platz' } } });
    expect((square.hotspots as unknown[])[0]).toMatchObject({
      i18n: { de: { title: 'Brunnen' }, fr: { title: 'Fontaine' } },
    });
  });

  it('says at the pano, and on Save, when its translations are over the size limit', async () => {
    server.setTour({ ...server.tour!.body, languages: { default: 'en', others: ['de'] } });
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    fireEvent.click(within(await openMenu(ui)).getByRole('button', { name: 'Deutsch' }));
    fireEvent.click(ui.getAllByRole('button', { name: 'Fountain' })[0]!);
    const point = ui.getByRole('group', { name: 'Edit point Fountain' });
    // More than the textarea allows (pasted through another tool, say).
    fireEvent.change(within(point).getByLabelText(/^Text/), {
      target: { value: 'x'.repeat(MAX_SCENE_TRANSLATION_CHARS + 1) },
    });
    expect(ui.getByText(/translations are over the 200,000-character limit/)).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Save' }));
    expect(
      await ui.findByText(/Pano “Square”: its translations are over the 200,000-character limit/),
    ).toBeTruthy();
    expect(server.writes().filter((w) => w.path.includes('/panos/'))).toEqual([]);
  });

  it('the Preview link carries the language being edited', async () => {
    server.setTour({ ...server.tour!.body, languages: { default: 'en', others: ['de'] } });
    const ui = openTab();
    await ui.findByRole('button', { name: /Tour title: Old town/ });
    expect(ui.getByRole('link', { name: 'Preview' }).getAttribute('href')).toBe(
      '/app/t/t1/preview',
    );
    fireEvent.click(within(await openMenu(ui)).getByRole('button', { name: 'Deutsch' }));
    expect(ui.getByRole('link', { name: 'Preview' }).getAttribute('href')).toBe(
      '/app/t/t1/preview?lang=de',
    );
  });
});

describe('model: translations', () => {
  const docs = (): EditorDocs =>
    fromServer({
      tour: { tourId: 't1', title: 'T', scenes: [{ panoId: 'p1' }] },
      etag: 'e',
      publish: null,
      configs: { p1: { config: { panoId: 'p1', title: 'Hall', hotspots: [] }, etag: 'c' } },
    } as never);

  it('setTranslation sets, clears and tidies away empty entries', () => {
    expect(setTranslation(undefined, 'de', 'title', 'Halle')).toEqual({ de: { title: 'Halle' } });
    expect(setTranslation({ de: { title: 'Halle' } }, 'de', 'title', null)).toBeUndefined();
    expect(
      setTranslation<'title' | 'body'>({ de: { title: 'Halle', body: 'x' } }, 'de', 'title', ''),
    ).toEqual({
      de: { body: 'x' },
    });
  });

  it('a translation added and cleared again leaves nothing to save', () => {
    let d = editorReducer(docs(), {
      type: 'scene/title',
      panoId: 'p1',
      title: 'Halle',
      lang: 'de',
    });
    d = editorReducer(d, { type: 'scene/title', panoId: 'p1', title: ' ', lang: 'de' });
    const s = d!.scenes.p1!;
    expect(s.kind === 'config' && s.current).toEqual(s.kind === 'config' && s.base);
  });
});

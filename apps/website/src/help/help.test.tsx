import { readFileSync } from 'node:fs';

import { cleanup, configure, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { renderSite } from '../__fixtures__/auth.js';
import { HELP_PAGES } from './pages.js';

// Lazy pages: load the chunks once up front, and give a loaded runner longer to render.
configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await Promise.all([import('../Shell.js'), import('../pages.js')]);
});
afterEach(cleanup);

describe('help pages', () => {
  it.each(HELP_PAGES.map((p) => [p.path, p]))('%s is a real page', async (_, page) => {
    renderSite(page.path);
    expect(await screen.findByRole('heading', { level: 1, name: page.title })).toBeTruthy();
    expect(document.title).toBe(`${page.title} · panote`);
    const nav = screen.getByRole('navigation', { name: 'Help pages' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(HELP_PAGES.map((p) => p.path));
    expect(within(nav).getByRole('link', { name: page.label }).className).toContain('active');
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
  });

  it('are linked from the footer’s Resources column, on every page', async () => {
    renderSite('/privacy');
    const resources = await screen.findByRole('navigation', { name: 'Resources' });
    expect(
      within(resources)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Docs', '/help'],
      ['Camera guide', '/help/cameras'],
      ['Embedding', '/help/embedding'],
    ]);
  });

  it('state the real limits and the embed code the share sheet gives', async () => {
    renderSite('/help/embedding');
    await screen.findByRole('heading', { level: 1, name: 'Embedding a tour' });
    expect(document.querySelector('pre')?.textContent).toBe(
      '<iframe src="https://panote.io/s/your-tour/embed"\n  width="100%" height="480" style="border:0"\n  allow="fullscreen"></iframe>',
    );
    cleanup();
    renderSite('/help');
    await screen.findByRole('heading', { level: 1, name: 'Help' });
    expect(document.body.textContent).toContain('can upload up to 50 photos a day');
    cleanup();
    renderSite('/help/cameras');
    await screen.findByRole('heading', { level: 1, name: 'Camera guide' });
    expect(document.body.textContent).toContain(
      'JPG, PNG or WebP, up to 150 MB and 150 megapixels',
    );
  });

  it('describe the editor as it is laid out: its cards, the map switch and the tour menu', async () => {
    renderSite('/help');
    await screen.findByRole('heading', { level: 1, name: 'Help' });
    for (const card of ['The Panos card', 'The Map card']) {
      expect(screen.getByRole('heading', { level: 3, name: card })).toBeTruthy();
    }
    expect(screen.queryByRole('heading', { name: 'The Tour card' })).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).toContain('The switch in the Map card’s title shows the map to visitors');
    expect(text).toContain('opens Tour settings');
    expect(text).not.toContain('sliders button');
  });

  it('use no em-dashes', () => {
    for (const file of ['./Help.tsx', './pages.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain('—');
    }
  });
});

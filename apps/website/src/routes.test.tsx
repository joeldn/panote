import { cleanup, configure, screen, within } from '@testing-library/react';
import { KNOWN_CONNECTIONS } from '@internal/web-kit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { renderSite } from './__fixtures__/auth.js';
import { routes } from './routes.js';

const renderAt = (path: string) => renderSite(path);

// Warm the lazy route modules once, so the first test doesn't time out on the transform.
// The first render of a lazy page can take over the default 1s on a loaded CI runner
// (seen under coverage); only the wait gets longer, the assertions are unchanged.
configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await Promise.all([import('./Shell.js'), import('./pages.js')]);
});
afterEach(cleanup);

describe('website routes', () => {
  it('renders the shell and the landing page', async () => {
    renderAt('/');
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Free.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it.each(['/privacy', '/terms', '/content-policy'])('renders %s', async (path) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('privacy covers accounts, likes, deletion and rights, plainly', async () => {
    renderAt('/privacy');
    await screen.findByRole('heading', { name: 'What we keep' });
    const page = (screen.getByRole('article').textContent ?? '').replace(/\s+/g, ' ');
    for (const { label } of Object.values(KNOWN_CONNECTIONS)) expect(page).toContain(label);
    expect(page).toContain('a one-time code we email to you');
    expect(page).toContain(
      'Google, Apple and email-code sign-ins with the same verified email address are joined into one account',
    );
    expect(page).toContain('Microsoft and Facebook each keep a separate one');
    expect(page).toContain('Signed in, your account id against the tour');
    expect(page).toContain('used for about a minute to limit abuse');
    expect(page).toContain('deleted within 30 days');
    expect(page).toContain('may set cookies under its own policy');
    expect(page).toContain('account menu, Account, Delete account');
    expect(page).toContain('up to 31 days');
    expect(page).toContain('people who already viewed it may still load its images');
    expect(page).toContain('Once your account is a week old, a public tour can appear in search');
    expect(page).toContain('complain to your data protection authority');
    expect(page).toContain('isn’t for anyone under 16');
    expect(page).toContain('Last updated 23 October 2026');
  });

  it('terms are short, set an age and point to the content policy, which the footer links', async () => {
    renderAt('/terms');
    await screen.findByRole('heading', { level: 1, name: 'Terms' });
    const article = screen.getByRole('article');
    const text = (article.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('You must be 16 or older');
    expect(text).toContain('keep your own copies of your originals');
    expect(
      within(article)
        .getByRole('link', { name: 'content and copyright policy' })
        .getAttribute('href'),
    ).toBe('/content-policy');
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getByRole('link', { name: 'Content policy' }).getAttribute('href')).toBe(
      '/content-policy',
    );
  });

  it('content policy says how to report, what happens, and how illegal images are handled', async () => {
    renderAt('/content-policy');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Content and copyright' }),
    ).toBeTruthy();
    for (const name of [
      'What isn’t allowed',
      'Report a tour',
      'What happens next',
      'Illegal images',
    ])
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    const page = (screen.getByRole('article').textContent ?? '').replace(/\s+/g, ' ');
    expect(page).toContain(
      'Except for illegal images, when something is taken down its owner is told why',
    );
    expect(page).toContain('NCMEC');
    expect(page).toContain('send the link only, never the images');
  });

  it('the legal pages make no export promise and name no operator', async () => {
    for (const path of ['/privacy', '/terms', '/content-policy']) {
      cleanup();
      renderAt(path);
      await screen.findByRole('heading', { level: 1 });
      const text = screen.getByRole('article').textContent ?? '';
      expect(text).not.toMatch(/export|download|open source|YOUR_/i);
    }
  });

  it('privacy names no sign-in provider the app does not offer', async () => {
    renderAt('/privacy');
    await screen.findByRole('heading', { name: 'What we keep' });
    expect(document.body.textContent).not.toMatch(/GitHub|LinkedIn/);
  });

  it('falls back to a 404 page', async () => {
    renderAt('/nope/deeper');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('loads the shell pages lazily and the tour routes eagerly', () => {
    const [tour, embed, shell] = routes;
    expect(tour?.element).toBeTruthy();
    expect(embed?.element).toBeTruthy();
    expect(tour?.lazy).toBeUndefined();
    expect(typeof shell?.lazy).toBe('function');
    expect(shell?.element).toBeUndefined();
    expect(shell?.children?.every((r) => typeof r.lazy === 'function' && !r.element)).toBe(true);
  });
});

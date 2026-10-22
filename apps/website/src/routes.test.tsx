import { cleanup, configure, screen, within } from '@testing-library/react';
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

  it('privacy describes self-serve account deletion', async () => {
    renderAt('/privacy');
    const choices = await screen.findByRole('heading', { name: 'Your choices' });
    const text = choices.nextElementSibling?.textContent ?? '';
    expect(text).toContain('choose Delete account');
    expect(text).toContain('sign-in record is removed within 30 days');
    expect(text).not.toContain('To delete your account, or to ask');
  });

  it('privacy says what a report or takedown keeps, even after account deletion', async () => {
    renderAt('/privacy');
    const holds = await screen.findByRole('heading', { name: 'Reports and legal holds' });
    const text = holds.nextElementSibling?.textContent ?? '';
    expect(text).toContain('as long as the law requires');
    expect(text).toContain('stays even if the account is deleted');
    expect(text).toContain('we keep your contact details');
    expect(screen.getByRole('article').textContent).toContain('Last updated 22 October 2026');
  });

  it('privacy is accurate about signed-in likes', async () => {
    renderAt('/privacy');
    await screen.findByRole('heading', { name: 'Visitors and analytics' });
    const page = screen.getByRole('article').textContent ?? '';
    expect(page).toContain('records your account id against that tour');
    expect(page).not.toContain('isn’t linked to an account');
  });

  it('content policy covers notices, counter-notices, repeat infringers and illegal images', async () => {
    renderAt('/content-policy');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Content and copyright' }),
    ).toBeTruthy();
    for (const name of [
      'What isn’t allowed',
      'Report a tour',
      'Copyright notices',
      'What we do',
      'Counter-notices',
      'Repeat infringers',
      'Illegal images',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    const page = screen.getByRole('article').textContent ?? '';
    expect(page).toContain('under penalty of perjury');
    expect(page).toContain('your signature');
    expect(page).toContain('NCMEC');
    expect(page).toContain('We keep a private copy');
    expect(page).toContain('account is closed');
  });

  it('terms point to the content policy, and the footer links it', async () => {
    renderAt('/terms');
    await screen.findByRole('heading', { level: 1, name: 'Terms' });
    const article = screen.getByRole('article');
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

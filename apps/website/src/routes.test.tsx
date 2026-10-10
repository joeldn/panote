import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { renderSite } from './__fixtures__/auth.js';
import { routes } from './routes.js';

const renderAt = (path: string) => renderSite(path);

// Warm the lazy route modules once, so the first test doesn't time out on the transform.
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

  it.each(['/privacy', '/terms'])('renders %s', async (path) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
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

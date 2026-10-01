import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSite } from './__fixtures__/auth.js';

const renderAt = (path: string) => renderSite(path);

afterEach(cleanup);

describe('website routes', () => {
  it('renders the shell and the landing page', async () => {
    renderAt('/');
    expect(within(screen.getByRole('banner')).getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Free.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it.each(['/privacy', '/terms'])('renders %s', (path) => {
    renderAt(path);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('falls back to a 404 page', () => {
    renderAt('/nope/deeper');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

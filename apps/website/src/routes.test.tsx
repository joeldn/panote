import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSite } from './__fixtures__/auth.js';

const renderAt = (path: string) => renderSite(path);

afterEach(cleanup);

describe('website routes', () => {
  it('renders the shell and the landing page', async () => {
    renderAt('/');
    expect(screen.getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Landing' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('routes a share link and its chrome-free embed', () => {
    renderAt('/s/my-tour');
    expect(screen.getByRole('heading', { name: 'Tour my-tour' })).toBeTruthy();
    cleanup();
    renderAt('/s/my-tour/embed');
    expect(screen.getByRole('heading', { name: 'Embed my-tour' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'panote.io' })).toBeNull();
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

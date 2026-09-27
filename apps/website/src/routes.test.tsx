import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { routes } from './routes.js';

const renderAt = (path: string) =>
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />);

afterEach(cleanup);

describe('website routes', () => {
  it('renders the shell and the landing page', () => {
    renderAt('/');
    expect(screen.getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Landing' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the sign-in placeholder from ?signin=1', () => {
    renderAt('/?signin=1');
    expect(screen.getByRole('dialog').textContent).toContain('Sign-in');
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

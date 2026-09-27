import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { routes } from './routes.js';

const renderAt = (path: string) =>
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { basename: '/app', initialEntries: [path] })}
    />,
  );

afterEach(cleanup);

describe('admin routes', () => {
  it('renders the shell and the dashboard at /app/', () => {
    renderAt('/app/');
    expect(screen.getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the upload overlay over the dashboard', () => {
    renderAt('/app/new');
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toBe('Upload');
  });

  it.each(['link', 'privacy', 'embed'])('opens the %s share tab over the editor', (tab) => {
    renderAt(`/app/t/tour-1/share/${tab}`);
    expect(screen.getByRole('heading', { name: 'Editor tour-1' })).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toBe(`Share: ${tab}`);
  });

  it('routes insights, preview and the Auth0 callback', () => {
    renderAt('/app/t/tour-1/insights');
    expect(screen.getByRole('dialog').textContent).toBe('Insights');
    cleanup();
    renderAt('/app/t/tour-1/preview');
    expect(screen.getByRole('heading', { name: 'Preview tour-1' })).toBeTruthy();
    cleanup();
    renderAt('/app/callback');
    expect(screen.getByRole('heading', { name: 'Signing in' })).toBeTruthy();
  });

  it('404s an unknown share tab and unknown paths', () => {
    renderAt('/app/t/tour-1/share/bogus');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    cleanup();
    renderAt('/app/nope');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

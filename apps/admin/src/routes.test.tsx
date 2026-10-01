import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderAdmin } from './__fixtures__/auth.js';

// Signed in (the default fake auth): the guard lets every route through.
const renderAt = (path: string) => renderAdmin(path);

afterEach(cleanup);

describe('admin routes', () => {
  it('renders the shell and the dashboard at /app/', async () => {
    renderAt('/app/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the upload overlay over the dashboard', async () => {
    renderAt('/app/new');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toBe('Upload');
  });

  it.each(['link', 'privacy', 'embed'])('opens the %s share tab over the editor', async (tab) => {
    renderAt(`/app/t/tour-1/share/${tab}`);
    expect(await screen.findByRole('heading', { name: 'Editor tour-1' })).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toBe(`Share: ${tab}`);
  });

  it('routes insights and preview', async () => {
    renderAt('/app/t/tour-1/insights');
    expect((await screen.findByRole('dialog')).textContent).toBe('Insights');
    cleanup();
    renderAt('/app/t/tour-1/preview');
    expect(await screen.findByRole('heading', { name: 'Preview tour-1' })).toBeTruthy();
  });

  it('404s an unknown share tab and unknown paths', async () => {
    renderAt('/app/t/tour-1/share/bogus');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    cleanup();
    renderAt('/app/nope');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

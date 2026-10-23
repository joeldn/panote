import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderAdmin } from './__fixtures__/auth.js';
import { FakeServer } from './__fixtures__/editor-server.js';

// Signed in (the default fake auth): the guard lets every route through.
const renderAt = (path: string) => {
  const server = new FakeServer();
  server.setTour({ tourId: 'tour-1', title: 'Tour one', scenes: [] });
  return renderAdmin(path, { fetch: server.fetch });
};
const editorShown = () => screen.findByRole('button', { name: /Tour title: Tour one/ });

afterEach(cleanup);

describe('admin routes', () => {
  it('renders the shell and the dashboard at /app/', async () => {
    renderAt('/app/');
    expect(await screen.findByRole('heading', { name: /^Welcome.*Maya Larsson\.$/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the upload overlay over the dashboard', async () => {
    renderAt('/app/new');
    expect(await screen.findByRole('heading', { name: /^Welcome.*Maya Larsson\.$/ })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'New tour' })).toBeTruthy();
  });

  it.each(['link', 'privacy', 'embed'])('opens the %s share tab over the editor', async (tab) => {
    renderAt(`/app/t/tour-1/share/${tab}`);
    expect(await editorShown()).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'Share this tour' })).toBeTruthy();
  });

  it('routes insights and preview', async () => {
    renderAt('/app/t/tour-1/insights');
    expect(await editorShown()).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'Insights' })).toBeTruthy();
    cleanup();
    renderAt('/app/t/tour-1/preview');
    expect(await screen.findByRole('heading', { name: 'Nothing to preview yet' })).toBeTruthy();
  });

  it('opens insights over the dashboard too', async () => {
    renderAt('/app/insights/tour-1');
    expect(await screen.findByRole('dialog', { name: 'Insights' })).toBeTruthy();
    expect(screen.getByText(/^Welcome.*Maya Larsson\.$/)).toBeTruthy();
  });

  it('sends the old unused panos page to the dashboard with that filter on', async () => {
    const { router } = renderAt('/app/panos/unused');
    expect(await screen.findByRole('heading', { name: /^Welcome.*Maya Larsson\.$/ })).toBeTruthy();
    expect(router.state.location.pathname).toMatch(/^\/app\/?$/);
    expect(router.state.location.search).toBe('?view=unused');
  });

  it('puts the invite page in the shell’s main, not a second one', async () => {
    renderAt('/app/invite#tour-1.short');
    expect(await screen.findByRole('heading', { name: 'Tour invite' })).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('opens the account window over the dashboard at /app/account', async () => {
    renderAt('/app/account');
    expect(await screen.findByRole('dialog', { name: 'Account' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Welcome/ })).toBeTruthy();
  });

  it('404s an unknown share tab and unknown paths', async () => {
    renderAt('/app/t/tour-1/share/bogus');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    cleanup();
    renderAt('/app/nope');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

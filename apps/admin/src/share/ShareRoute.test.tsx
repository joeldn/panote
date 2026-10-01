import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ApiError, AuthRequiredError, loadConfig, type AdminApi } from '@internal/web-kit';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigContext } from '../config-context.js';
import { SessionContext } from '../session.js';
import { ShareRoute } from './ShareRoute.js';

// The share routes alone, under a stand-in editor: the real tree's guard is tested elsewhere.
const routes: RouteObject[] = [
  {
    path: 't/:tourId',
    element: <Outlet />,
    children: [
      { index: true, element: <p>Editor</p> },
      ...(['link', 'privacy', 'embed'] as const).map((tab) => ({
        path: `share/${tab}`,
        element: <ShareRoute tab={tab} />,
      })),
    ],
  },
];

const config = loadConfig({
  VITE_SITE_ORIGIN: 'https://panote.io',
  VITE_CDN_BASE: 'https://cdn.panote.io/',
  VITE_AUTH0_DOMAIN: 'panote.au.auth0.com',
  VITE_AUTH0_CLIENT_ID: 'client',
  VITE_AUTH0_AUDIENCE: 'https://api.panote.io',
});

const tourOk = (publish: { slug: string; visibility: 'public' | 'unlisted' } | null) => ({
  status: 'ok' as const,
  data: {
    etag: 'e1',
    tour: {
      tourId: 'tour-1',
      title: 'Old Town',
      startPanoId: 'pano-1',
      scenes: [{ panoId: 'pano-1' }, { panoId: 'pano-2' }],
    },
    configs: {
      'pano-1': { etag: 'c1', config: { panoId: 'pano-1', title: 'Square', hotspots: [] } },
      'pano-2': { etag: 'c2', config: { panoId: 'pano-2', title: 'Courtyard', hotspots: [] } },
    },
    publish: publish && { ...publish, publishedAt: '2026-09-26T00:00:00.000Z' },
  },
});

const PUBLISHED = { slug: 'old-town', visibility: 'public' as const };

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  const fail = () => Promise.reject(new Error('unexpected call'));
  return {
    listTours: fail,
    listPanos: fail,
    getTour: fail,
    getTourWithConfigs: vi.fn(async () => tourOk(PUBLISHED)) as AdminApi['getTourWithConfigs'],
    getPano: fail,
    getPanoStatus: fail,
    createTour: fail,
    putTour: fail,
    putPanoConfig: fail,
    createPanoConfig: fail,
    deleteTour: fail,
    deletePano: fail,
    publishTour: vi.fn(async () => ({
      slug: 'old-town',
      visibility: 'unlisted' as const,
      url: '/s/old-town',
      publishedAt: '2026-09-26T00:00:00.000Z',
    })),
    renameSlug: vi.fn(async (_id: string, slug: string) => ({
      slug,
      oldSlugRedirectsUntil: '2026-10-31T00:00:00.000Z',
    })),
    setVisibility: vi.fn(async (_id: string, visibility: 'public' | 'unlisted') => ({
      visibility,
    })),
    unpublishTour: fail,
    ...overrides,
  };
}

function renderShare(path: string, api: AdminApi = fakeApi()) {
  const router = createMemoryRouter(routes, { basename: '/app', initialEntries: [path] });
  render(
    <ConfigContext value={config}>
      <SessionContext
        value={{
          user: { sub: 'u1' },
          api,
          upload: { presign: vi.fn() },
          requestSignIn: () => {},
          holdSignIn: () => {},
          signOut: async () => {},
        }}
      >
        <RouterProvider router={router} />
      </SessionContext>
    </ConfigContext>,
  );
  return { api, router };
}

const editSlug = async (value: string) => {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit custom link' }));
  const input = screen.getByRole('textbox', { name: 'Custom link' });
  fireEvent.change(input, { target: { value } });
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  return input;
};

const clickPublish = async () => {
  const button = await screen.findByRole('button', { name: 'Publish link' });
  await act(async () => fireEvent.click(button));
};

afterEach(cleanup);

describe('share route', () => {
  it('loads the tour and shows its link on the env host', async () => {
    const { api } = renderShare('/app/t/tour-1/share/link');
    expect(await screen.findByText('panote.io/s/old-town')).toBeTruthy();
    expect(api.getTourWithConfigs).toHaveBeenCalledWith('tour-1');
    expect(screen.getByRole('tab', { name: 'Link' }).getAttribute('aria-selected')).toBe('true');
  });

  it('renames the slug and says how long the old link redirects', async () => {
    const { api } = renderShare('/app/t/tour-1/share/link');
    await editSlug('New Town');
    expect(api.renameSlug).toHaveBeenCalledWith('tour-1', 'new-town');
    expect(screen.getByText('panote.io/s/new-town')).toBeTruthy();
    // Expiry is a UTC midnight; it must not render as the day before west of UTC.
    expect(
      screen.getByText(/The old link \/s\/old-town redirects here until .*31.*2026/),
    ).toBeTruthy();
  });

  it('shows a 409 slug taken inline and keeps the old link', async () => {
    const renameSlug = vi.fn(() => Promise.reject(new ApiError(409, { error: 'slug taken' })));
    renderShare('/app/t/tour-1/share/link', fakeApi({ renameSlug }));
    await editSlug('taken-link');
    expect(screen.getByRole('alert').textContent).toBe('That link is already taken. Try another.');
    expect(screen.getByText('panote.io/s/old-town')).toBeTruthy();
  });

  it('keeps a failed rename visible when the blur came from a tab switch', async () => {
    let reject: (e: unknown) => void = () => {};
    const renameSlug = vi.fn(
      () =>
        new Promise<never>((_, r) => {
          reject = r;
        }),
    );
    const { router } = renderShare('/app/t/tour-1/share/link', fakeApi({ renameSlug }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit custom link' }));
    const input = screen.getByRole('textbox', { name: 'Custom link' });
    fireEvent.change(input, { target: { value: 'taken-link' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('tab', { name: 'Privacy' }));
    await act(async () => reject(new ApiError(409, { error: 'slug taken' })));
    expect(router.state.location.pathname).toBe('/app/t/tour-1/share/privacy');
    expect(renameSlug).toHaveBeenCalledWith('tour-1', 'taken-link');
    expect(
      screen.getByText('Couldn’t change the link: That link is already taken. Try another.'),
    ).toBeTruthy();
  });

  it('keeps a renamed slug when visibility changes afterwards', async () => {
    const { api } = renderShare('/app/t/tour-1/share/link');
    await editSlug('new-town');
    fireEvent.click(screen.getByRole('tab', { name: 'Privacy' }));
    const unlisted = await screen.findByRole('radio', { name: /Unlisted/ });
    await act(async () => fireEvent.click(unlisted));
    expect(api.setVisibility).toHaveBeenCalledWith('tour-1', 'unlisted');
    fireEvent.click(screen.getByRole('tab', { name: 'Link' }));
    expect(await screen.findByText('panote.io/s/new-town')).toBeTruthy();
    expect(screen.getByText('Unlisted', { selector: 'b' })).toBeTruthy();
  });

  it('switches tabs in the URL, keeping ?pano=', async () => {
    const { router } = renderShare('/app/t/tour-1/share/link?pano=pano-2');
    fireEvent.click(await screen.findByRole('tab', { name: 'Embed' }));
    expect(router.state.location.pathname).toBe('/app/t/tour-1/share/embed');
    expect(router.state.location.search).toBe('?pano=pano-2');
    expect(await screen.findByText('Courtyard — no links out')).toBeTruthy();
  });

  it('builds the embed snippet for the current pano', async () => {
    renderShare('/app/t/tour-1/share/embed?pano=pano-2');
    fireEvent.click(await screen.findByRole('radio', { name: /This pano only/ }));
    expect(screen.getByLabelText('Embed code', { selector: 'pre' }).textContent).toBe(
      '<iframe src="https://panote.io/s/old-town/embed?pano=pano-2"\n' +
        '  width="100%" height="480" style="border:0"\n' +
        '  allow="fullscreen; xr-spatial-tracking"></iframe>',
    );
  });

  it('patches visibility from the Privacy tab', async () => {
    const { api } = renderShare('/app/t/tour-1/share/privacy');
    const group = await screen.findByRole('radiogroup', { name: 'Who can see this tour' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    await act(async () => fireEvent.click(within(group).getByRole('radio', { name: /Unlisted/ })));
    expect(api.setVisibility).toHaveBeenCalledWith('tour-1', 'unlisted');
    expect(screen.getByText('Unlisted', { selector: 'b' })).toBeTruthy();
  });

  it('closes back to the editor', async () => {
    const { router } = renderShare('/app/t/tour-1/share/link?pano=pano-2');
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    expect(router.state.location.search).toBe('?pano=pano-2');
  });

  it('publishes an unpublished tour on request', async () => {
    const api = fakeApi({
      getTourWithConfigs: vi.fn(async () => tourOk(null)) as AdminApi['getTourWithConfigs'],
    });
    renderShare('/app/t/tour-1/share/link', api);
    await clickPublish();
    expect(api.publishTour).toHaveBeenCalledWith('tour-1');
    expect(screen.getByText('panote.io/s/old-town')).toBeTruthy();
    expect(screen.getByText('Unlisted', { selector: 'b' })).toBeTruthy();
  });

  it('asks for a new slug when publish reports 409 slug lost', async () => {
    const publishTour = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { error: 'slug lost' }))
      .mockResolvedValueOnce({
        slug: 'fresh-link',
        visibility: 'unlisted',
        url: '/s/fresh-link',
        publishedAt: '2026-09-26T00:00:00.000Z',
      });
    const api = fakeApi({
      getTourWithConfigs: vi.fn(async () => tourOk(null)) as AdminApi['getTourWithConfigs'],
      publishTour,
    });
    renderShare('/app/t/tour-1/share/link', api);
    await clickPublish();
    expect(screen.getByText(/now belongs to another tour/)).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Custom link' });
    fireEvent.change(input, { target: { value: 'fresh-link' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(publishTour).toHaveBeenLastCalledWith('tour-1', { slug: 'fresh-link' });
    expect(screen.getByText('panote.io/s/fresh-link')).toBeTruthy();
  });

  it('lists the panos a 422 publish rejected', async () => {
    const publishTour = vi.fn(() =>
      Promise.reject(
        new ApiError(422, {
          error: 'scenes not publishable',
          scenes: [{ panoId: 'pano-2', reason: 'not-ready' }],
        }),
      ),
    );
    const api = fakeApi({
      getTourWithConfigs: vi.fn(async () => tourOk(null)) as AdminApi['getTourWithConfigs'],
      publishTour,
    });
    renderShare('/app/t/tour-1/share/link', api);
    await clickPublish();
    expect(screen.getByRole('alert').textContent).toBe(
      'Some panos can’t be published yet: Courtyard (still processing).',
    );
  });

  it('asks to sign in again when there is no session', async () => {
    render(
      <ConfigContext value={config}>
        <RouterProvider
          router={createMemoryRouter(routes, {
            basename: '/app',
            initialEntries: ['/app/t/tour-1/share/link'],
          })}
        />
      </ConfigContext>,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Sign in again to share this tour.',
    );
  });

  it('shows a load failure in place of the tabs', async () => {
    const api = fakeApi({
      getTourWithConfigs: vi.fn(() =>
        Promise.reject(new AuthRequiredError()),
      ) as AdminApi['getTourWithConfigs'],
    });
    renderShare('/app/t/tour-1/share/link', api);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Sign in again to share this tour.',
    );
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

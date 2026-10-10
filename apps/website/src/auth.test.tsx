import { cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, renderSite } from './__fixtures__/auth.js';

// The Shell and its pages are lazy routes: load their modules once up front, so the first
// test's queries don't time out on the module transform.
// The first render of a lazy page can take over the default 1s on a loaded CI runner
// (seen under coverage); only the wait gets longer, the assertions are unchanged.
configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await Promise.all([import('./Shell.js'), import('./pages.js')]);
});
afterEach(cleanup);

const google = () => screen.getByRole('button', { name: 'Continue with Google' });
// The modal renders once the lazy Shell route has loaded.
const findGoogle = () => screen.findByRole('button', { name: 'Continue with Google' });

describe('sign-in modal', () => {
  it('opens from ?signin=1 with Google only (Q2)', async () => {
    renderSite('/?signin=1');
    expect(await screen.findByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Continue with/ })).toHaveLength(1);
    expect(screen.queryByText(/Apple|Facebook/)).toBeNull();
  });

  it('starts Google sign-in back to next, keeping its query flag (Q1)', async () => {
    const { auth } = renderSite('/?signin=1&next=%2Fapp%2Fnew%3Fresume%3Dupload');
    fireEvent.click(await findGoogle());
    expect(auth.signIn).toHaveBeenCalledWith({
      connection: 'google-oauth2',
      returnTo: '/app/new?resume=upload',
    });
    await waitFor(() => expect((google() as HTMLButtonElement).disabled).toBe(true));
  });

  it('defaults to the dashboard without next', async () => {
    const { auth } = renderSite('/?signin=1');
    fireEvent.click(await findGoogle());
    expect(auth.signIn).toHaveBeenCalledWith({ connection: 'google-oauth2', returnTo: '/app/' });
  });

  it.each([
    'https://evil.example/app/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
  ])('drops an off-site next (%s)', async (next) => {
    const { auth } = renderSite(`/?signin=1&next=${encodeURIComponent(next)}`);
    fireEvent.click(await findGoogle());
    expect(auth.signIn).toHaveBeenCalledWith({ connection: 'google-oauth2', returnTo: '/app/' });
  });

  it('shows a failed start', async () => {
    const auth = fakeAuth({ signIn: vi.fn().mockRejectedValue(new Error('network down')) });
    renderSite('/?signin=1', auth);
    fireEvent.click(await findGoogle());
    expect((await screen.findByRole('alert')).textContent).toBe('network down');
  });

  it('closes by dropping signin and next from the URL', async () => {
    const { router } = renderSite('/privacy?signin=1&next=%2Fapp%2F&x=1');
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/privacy');
    expect(router.state.location.search).toBe('?x=1');
  });

  it('opens from the nav "Sign in" link over the current page', async () => {
    const { router } = renderSite('/terms?x=1');
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link.getAttribute('href')).toBe('/terms?x=1&signin=1');
    fireEvent.click(link);
    expect(await screen.findByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/terms');
    expect(screen.getByRole('heading', { name: 'Terms' })).toBeTruthy();
  });

  it('keeps an existing next on the "Sign in" link', async () => {
    renderSite('/?next=%2Fapp%2Fnew%3Fresume%3D1');
    const link = await screen.findByRole('link', { name: 'Sign in' });
    const url = new URL(link.getAttribute('href')!, LOCAL.website);
    expect(url.searchParams.get('signin')).toBe('1');
    expect(url.searchParams.get('next')).toBe('/app/new?resume=1');
  });

  it('explains instead of offering buttons when auth is unconfigured', async () => {
    const auth = fakeAuth({ configured: false, connections: [] });
    renderSite('/?signin=1', auth);
    expect((await screen.findByRole('status')).textContent).toContain('isn’t set up');
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
    expect(auth.isAuthenticated).not.toHaveBeenCalled();
  });
});

describe('account nav', () => {
  const signedIn = () =>
    fakeAuth({
      isAuthenticated: vi.fn(async () => true),
      getUser: vi.fn(async () => ({ name: 'Maya Larsson', email: 'maya@example.com' })),
    });

  it('shows My tours and the account menu when signed in', async () => {
    renderSite('/', signedIn());
    const avatar = await screen.findByRole('button', { name: 'Account: Maya Larsson' });
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('link', { name: 'My tours' }).getAttribute('href')).toBe(
      `${LOCAL.admin}/app/`,
    );
    fireEvent.click(avatar);
    expect(screen.getByRole('menu').textContent).toContain('maya@example.com');
  });

  it('signs out back to the website home, dropping parked editor drafts', async () => {
    localStorage.setItem('panote:editor-draft:google-oauth2|1:t1', '{}');
    localStorage.setItem('panote.currentTour', 't1');
    const auth = signedIn();
    renderSite('/', auth);
    fireEvent.click(await screen.findByRole('button', { name: /Account/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledWith(`${LOCAL.website}/`);
    expect(localStorage.getItem('panote:editor-draft:google-oauth2|1:t1')).toBeNull();
    expect(localStorage.getItem('panote.currentTour')).toBe('t1');
    localStorage.clear();
  });

  it('falls back to "Sign in" if the session check fails', async () => {
    renderSite('/', fakeAuth({ isAuthenticated: vi.fn().mockRejectedValue(new Error('x')) }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('never loads auth on the embed route', () => {
    const auth = fakeAuth();
    renderSite('/s/tour/embed', auth);
    expect(auth.isAuthenticated).not.toHaveBeenCalled();
  });
});

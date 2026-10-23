import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin, USER } from '../__fixtures__/auth.js';

// What the dialog keeps across the re-auth redirect: the account that asked.
const DELETING_SUB_KEY = 'panote:delete-account:sub';

// The first render in a cold worker can exceed the 1s default under a loaded `turbo test`.
configure({ asyncUtilTimeout: 5000 });
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The dashboard's lists, the account window's reads, and whatever the delete answers. */
function server(account: () => Response) {
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    if (key === 'GET /api/admin/tours') return json({ tours: [], cursor: null });
    if (key === 'GET /api/admin/panos') return json({ panoIds: [], panos: [], cursor: null });
    if (key === 'GET /api/admin/account') return json({ email: USER.email, signIns: ['email'] });
    if (key === 'GET /api/upload-url') {
      const limits = { maxPanos: null, maxBytes: null, maxUploadsPerDay: null };
      return json({ panos: 0, bytes: 0, uploadsToday: 0, limits });
    }
    if (key === 'DELETE /api/admin/account') return account();
    throw new Error(`unexpected ${key}`);
  });
}

/** Avatar menu, Account…, then the window's Delete account. */
async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Account: Maya Larsson' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Account…' }));
  const account = await screen.findByRole('dialog', { name: 'Account' });
  fireEvent.click(within(account).getByRole('button', { name: 'Delete account' }));
  return screen.getByRole('dialog', { name: 'Delete your account?' });
}

const deleteButton = () =>
  within(screen.getByRole('dialog', { name: 'Delete your account?' })).getByRole('button', {
    name: 'Delete account',
  }) as HTMLButtonElement;
const phraseInput = () => screen.getByRole('textbox', { name: /to confirm/ });

describe('Delete account', () => {
  it('stays disabled until the phrase is typed exactly, then deletes and signs out', async () => {
    const auth = fakeAuth();
    const fetch = server(() => json({ status: 'deleted' }));
    renderAdmin('/app/', { auth, fetch });
    const dialog = await openDialog();
    expect(dialog.textContent).toContain('sign-in record is removed within 30 days');

    expect(deleteButton().disabled).toBe(true);
    fireEvent.change(phraseInput(), { target: { value: 'delete my' } });
    expect(deleteButton().disabled).toBe(true);
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    expect(deleteButton().disabled).toBe(false);
    fireEvent.click(deleteButton());

    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith('http://localhost:5174/'));
    const call = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ confirm: 'delete my account' });
  });

  it('never offers a retry when sign-out fails after the delete: leaves for the website', async () => {
    const auth = fakeAuth({
      signOut: vi.fn(async () => Promise.reject(new Error('popup blocked'))),
    });
    const { assign } = renderAdmin('/app/', {
      auth,
      fetch: server(() => json({ status: 'deleted' })),
    });
    await openDialog();
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:5174/'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats a pending delete as done', async () => {
    const auth = fakeAuth();
    renderAdmin('/app/', { auth, fetch: server(() => json({ status: 'pending' }, 202)) });
    await openDialog();
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });

  it('shows a failure, keeps the dialog open and stays signed in', async () => {
    const auth = fakeAuth();
    renderAdmin('/app/', { auth, fetch: server(() => json({ error: 'boom' }, 500)) });
    await openDialog();
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    expect((await screen.findByRole('alert')).textContent).toContain('couldn’t be deleted');
    expect(screen.getByRole('dialog', { name: 'Delete your account?' })).toBeTruthy();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('asks for a fresh sign-in when the server wants one, coming back to this page', async () => {
    const auth = fakeAuth();
    const fetch = server(() => json({ error: 'reauthentication required' }, 403));
    renderAdmin('/app/?tab=tours', { auth, fetch });
    await openDialog();
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    const signIn = await screen.findByRole('dialog', {
      name: 'Sign in again to delete your account',
    });
    expect(screen.queryByRole('dialog', { name: 'Delete your account?' })).toBeNull();
    fireEvent.click(within(signIn).getByRole('button', { name: /Google/ }));
    await waitFor(() =>
      expect(auth.signIn).toHaveBeenCalledWith({
        connection: 'google-oauth2',
        returnTo: '/app/?tab=tours&delete-account=reauthenticated',
        reauthenticate: true,
        loginHint: USER.email,
      }),
    );
    expect(sessionStorage.getItem(DELETING_SUB_KEY)).toBe(USER.sub);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('back from signing in again: reopens the dialog, drops the param, and deletes', async () => {
    sessionStorage.setItem(DELETING_SUB_KEY, USER.sub);
    const auth = fakeAuth();
    const { router } = renderAdmin('/app/?delete-account=reauthenticated', {
      auth,
      fetch: server(() => json({ status: 'deleted' })),
    });
    await screen.findByRole('dialog', { name: 'Delete your account?' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(sessionStorage.getItem(DELETING_SUB_KEY)).toBeNull();
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });

  it.each([
    ['as a different account', 'google-oauth2|someone-else', /different account/],
    ['with no record of who asked', null, /couldn’t tell which account/],
  ])('back from signing in again %s: refuses to delete', async (_label, asked, message) => {
    if (asked) sessionStorage.setItem(DELETING_SUB_KEY, asked);
    const fetch = server(() => json({ status: 'deleted' }));
    const auth = fakeAuth();
    renderAdmin('/app/?delete-account=reauthenticated', { auth, fetch });
    await screen.findByRole('dialog', { name: 'Delete your account?' });
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    expect(deleteButton().disabled).toBe(true);
    fireEvent.click(deleteButton());
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('says so, instead of looping, when a fresh sign-in is still refused', async () => {
    sessionStorage.setItem(DELETING_SUB_KEY, USER.sub);
    const auth = fakeAuth();
    renderAdmin('/app/?delete-account=reauthenticated', {
      auth,
      fetch: server(() => json({ error: 'reauthentication required' }, 403)),
    });
    await screen.findByRole('dialog', { name: 'Delete your account?' });
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'couldn’t confirm your sign-in',
    );
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('cancel closes without deleting and clears what was typed', async () => {
    const fetch = server(() => json({ status: 'deleted' }));
    renderAdmin('/app/', { fetch });
    await openDialog();
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Delete your account?' })).toBeNull();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await openDialog();
    expect((phraseInput() as HTMLInputElement).value).toBe('');
  });
});

import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';

// The first render in a cold worker can exceed the 1s default under a loaded `turbo test`.
configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The dashboard's lists, plus whatever the account route answers. */
function server(account: () => Response) {
  return vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    if (key === 'GET /api/admin/tours') return json({ tours: [], cursor: null });
    if (key === 'GET /api/admin/panos') return json({ panoIds: [], panos: [], cursor: null });
    if (key === 'DELETE /api/admin/account') return account();
    throw new Error(`unexpected ${key}`);
  });
}

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Account: Maya Larsson' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete account' }));
  return screen.getByRole('dialog', { name: 'Delete your account?' });
}

const deleteButton = () =>
  screen.getByRole('button', { name: 'Delete account' }) as HTMLButtonElement;
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
      }),
    );
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('back from signing in again: reopens the dialog, drops the param, and deletes', async () => {
    const auth = fakeAuth();
    const { router } = renderAdmin('/app/?delete-account=reauthenticated', {
      auth,
      fetch: server(() => json({ status: 'deleted' })),
    });
    await screen.findByRole('dialog', { name: 'Delete your account?' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    fireEvent.change(phraseInput(), { target: { value: 'delete my account' } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });

  it('says so, instead of looping, when a fresh sign-in is still refused', async () => {
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

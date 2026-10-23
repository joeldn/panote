import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MembersOk } from '@internal/contracts';
import {
  ApiError,
  ReauthRequiredError,
  type AdminApi,
  type InviteAcceptResult,
  type TransferAcceptResult,
} from '@internal/web-kit';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, TEST_CONFIG } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { SessionContext } from '../session.js';
import { InviteRoute } from './InviteRoute.js';
import { PeopleRoute } from './PeopleRoute.js';

const routes: RouteObject[] = [
  {
    path: '/',
    element: <Outlet />,
    children: [
      { index: true, element: <p>Dashboard</p> },
      { path: 'invite', element: <InviteRoute /> },
      {
        path: 't/:tourId',
        element: <Outlet />,
        children: [
          { index: true, element: <p>Editor</p> },
          { path: 'people', element: <PeopleRoute /> },
        ],
      },
    ],
  },
];

const TOKEN = `tour-1.${'a'.repeat(43)}`;

function renderAt(path: string, api: Partial<AdminApi>, auth = fakeAuth()) {
  const router = createMemoryRouter(routes, { basename: '/app', initialEntries: [path] });
  render(
    <ConfigContext value={TEST_CONFIG}>
      <AuthEnvContext value={{ auth, origins: LOCAL, assign: vi.fn(), apiBase: '' }}>
        <SessionContext
          value={{
            user: { sub: 'u1' },
            api: api as AdminApi,
            upload: { presign: vi.fn(), presignPlan: vi.fn(), getUsage: vi.fn() },
            requestSignIn: () => {},
            holdSignIn: () => {},
            signOut: async () => {},
          }}
        >
          <RouterProvider router={router} />
        </SessionContext>
      </AuthEnvContext>
    </ConfigContext>,
  );
  return { router, auth };
}

const owned = (over: Partial<MembersOk> = {}): MembersOk => ({
  role: 'owner',
  ownerEmail: 'maya@example.com',
  members: [
    {
      id: 'm1',
      email: 'ed@example.com',
      role: 'editor',
      addedAt: '2026-10-20T00:00:00Z',
      you: false,
    },
  ],
  invites: [
    {
      id: 'i1',
      email: 'kim@example.com',
      role: 'editor',
      createdAt: '2026-10-22T00:00:00Z',
      expiresAt: '2026-10-29T00:00:00Z',
    },
  ],
  transfer: null,
  ...over,
});

afterEach(cleanup);

describe('People', () => {
  it('lets the owner invite, then shows the link to send', async () => {
    const createInvite = vi.fn(async () => ({
      invite: {
        id: 'i2',
        email: 'new@example.com',
        role: 'editor' as const,
        createdAt: '2026-10-23T00:00:00Z',
        expiresAt: '2026-10-30T00:00:00Z',
      },
      token: TOKEN,
    }));
    const getMembers = vi.fn(async () => owned());
    renderAt('/app/t/tour-1/people', { getMembers, createInvite });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    expect(await within(dialog).findByText('ed@example.com')).toBeTruthy();
    expect(within(dialog).getByText('kim@example.com')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Invite an editor'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    const link = (await within(dialog).findByLabelText('Invite link')) as HTMLInputElement;
    expect(createInvite).toHaveBeenCalledWith('tour-1', 'new@example.com');
    expect(link.value).toBe(`${window.location.origin}/app/invite#${TOKEN}`);
    expect(within(dialog).getByText('new@example.com')).toBeTruthy();
    // The list is read again, so the new invite shows under Invited.
    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(2));
  });

  it('says why an invite was refused', async () => {
    const createInvite = vi.fn(async () => {
      throw new ApiError(409, { error: 'already an editor' });
    });
    renderAt('/app/t/tour-1/people', { getMembers: async () => owned(), createInvite });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    await within(dialog).findByText('ed@example.com');
    fireEvent.change(within(dialog).getByLabelText('Invite an editor'), {
      target: { value: 'ed@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'They can already edit this tour.',
    );
  });

  it('cancels an invite and removes an editor after a confirm', async () => {
    const revokeInvite = vi.fn(async () => {});
    const removeMember = vi.fn(async () => {});
    renderAt('/app/t/tour-1/people', {
      getMembers: async () => owned(),
      revokeInvite,
      removeMember,
    });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Cancel the invite for kim@example.com' }),
    );
    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith('tour-1', 'i1'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove ed@example.com' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove this editor?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('tour-1', 'm1'));
  });

  it('shows an editor who else edits, no invite form, and lets them leave', async () => {
    const removeMember = vi.fn(async () => {});
    renderAt('/app/t/tour-1/people', {
      getMembers: async () =>
        owned({
          role: 'editor',
          invites: [],
          members: [
            {
              id: 'm1',
              email: 'ed@example.com',
              role: 'editor',
              addedAt: '2026-10-20T00:00:00Z',
              you: true,
            },
          ],
        }),
      removeMember,
    });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    expect(await within(dialog).findByText('maya@example.com')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Invite an editor')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Remove/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    const confirm = await screen.findByRole('dialog', { name: 'Leave this tour?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Leave' }));
    await screen.findByText('Dashboard');
    expect(removeMember).toHaveBeenCalledWith('tour-1', 'm1');
  });
});

describe('handing the tour over', () => {
  const offered = { memberId: 'm1', expiresAt: '2026-10-30T00:00:00Z' };
  const asEditor = (over: Partial<MembersOk> = {}) =>
    owned({
      role: 'editor',
      invites: [],
      members: [
        {
          id: 'm1',
          email: 'ed@example.com',
          role: 'editor',
          addedAt: '2026-10-20T00:00:00Z',
          you: true,
        },
      ],
      transfer: offered,
      ...over,
    });

  it('lets the owner offer it to an editor, after a confirm', async () => {
    const offerTransfer = vi.fn(async () => ({ transfer: offered }));
    const getMembers = vi.fn(async () => owned());
    renderAt('/app/t/tour-1/people', { getMembers, offerTransfer });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Make ed@example.com the owner' }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Make them the owner?' });
    expect(confirm.textContent).toContain('you stay on as an editor');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Offer the tour' }));
    await waitFor(() => expect(offerTransfer).toHaveBeenCalledWith('tour-1', 'm1'));
    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(2));
  });

  it('asks the owner to sign in again when the last sign-in is too old', async () => {
    const offerTransfer = vi.fn(async () => {
      throw new ReauthRequiredError({ error: 'reauthentication required' });
    });
    const { auth } = renderAt('/app/t/tour-1/people', {
      getMembers: async () => owned(),
      offerTransfer,
    });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Make ed@example.com the owner' }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Make them the owner?' })).getByRole(
        'button',
        {
          name: 'Offer the tour',
        },
      ),
    );
    await screen.findByRole('dialog', { name: 'Sign in again to offer this tour' });
    fireEvent.click(screen.getByRole('button', { name: /Google/ }));
    await waitFor(() =>
      expect(auth.signIn).toHaveBeenCalledWith({
        connection: 'google-oauth2',
        returnTo: '/app/t/tour-1/people',
        reauthenticate: true,
      }),
    );
  });

  it('shows the owner an open offer, which they can withdraw', async () => {
    const cancelTransfer = vi.fn(async () => {});
    renderAt('/app/t/tour-1/people', {
      getMembers: async () => owned({ transfer: offered }),
      cancelTransfer,
    });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    expect(await within(dialog).findByText(/^Offered the tour until/)).toBeTruthy();
    expect(
      within(dialog).queryByRole('button', { name: 'Make ed@example.com the owner' }),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Withdraw the offer to ed@example.com' }),
    );
    await waitFor(() => expect(cancelTransfer).toHaveBeenCalledWith('tour-1'));
  });

  it('lets the editor it names take the tour over, then shows their tours', async () => {
    const acceptTransfer = vi.fn(async (): Promise<TransferAcceptResult> => ({
      status: 'ok',
      data: { tourId: 'tour-1' },
    }));
    renderAt('/app/t/tour-1/people', { getMembers: async () => asEditor(), acceptTransfer });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    expect((await within(dialog).findByRole('status')).textContent).toContain(
      'maya@example.com wants to make you this tour’s owner',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Become the owner' }));
    await screen.findByText('Dashboard');
    expect(acceptTransfer).toHaveBeenCalledWith('tour-1');
  });

  it('says why taking it over was refused, and lets the editor decline', async () => {
    const cancelTransfer = vi.fn(async () => {});
    renderAt('/app/t/tour-1/people', {
      getMembers: async () => asEditor(),
      acceptTransfer: async () => ({
        status: 'refused',
        refusal: { error: 'storage limit reached' },
      }),
      cancelTransfer,
    });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Become the owner' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('storage limit');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(cancelTransfer).toHaveBeenCalledWith('tour-1'));
  });

  it('shows another editor no offer', async () => {
    renderAt('/app/t/tour-1/people', {
      getMembers: async () =>
        asEditor({
          members: [
            {
              id: 'm1',
              email: 'ed@example.com',
              role: 'editor',
              addedAt: '2026-10-20T00:00:00Z',
              you: false,
            },
            {
              id: 'm2',
              email: 'kim@example.com',
              role: 'editor',
              addedAt: '2026-10-21T00:00:00Z',
              you: true,
            },
          ],
        }),
    });
    const dialog = await screen.findByRole('dialog', { name: 'People' });
    await within(dialog).findByText('kim@example.com');
    expect(within(dialog).queryByRole('button', { name: 'Become the owner' })).toBeNull();
  });
});

describe('the invite link', () => {
  it('accepts and opens the tour', async () => {
    const acceptInvite = vi.fn(async (): Promise<InviteAcceptResult> => ({
      status: 'ok',
      data: { tourId: 'tour-1' },
    }));
    const { router } = renderAt(`/app/invite#${TOKEN}`, { acceptInvite });
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/tour-1'));
    expect(acceptInvite).toHaveBeenCalledWith(TOKEN);
  });

  it('asks to sign in with the invited address when the account is another', async () => {
    const acceptInvite = vi.fn(async (): Promise<InviteAcceptResult> => ({
      status: 'refused',
      refusal: { error: 'wrong account', email: 'ed@example.com' },
    }));
    const { auth } = renderAt(`/app/invite#${TOKEN}`, { acceptInvite });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This invite is for ed@example.com',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as ed@example.com' }));
    fireEvent.click(await screen.findByRole('button', { name: /Google/ }));
    await waitFor(() =>
      expect(auth.signIn).toHaveBeenCalledWith({
        connection: 'google-oauth2',
        returnTo: `/app/invite#${TOKEN}`,
        reauthenticate: true,
        loginHint: 'ed@example.com',
      }),
    );
  });

  it('says so for an expired invite, and for a link cut short', async () => {
    renderAt(`/app/invite#${TOKEN}`, {
      acceptInvite: async () => ({
        status: 'refused',
        refusal: { error: 'invite expired', email: 'ed@example.com' },
      }),
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This invite has expired. Ask the tour’s owner for a new one.',
    );
    cleanup();
    const acceptInvite = vi.fn();
    renderAt('/app/invite#tour-1.short', { acceptInvite });
    expect((await screen.findByRole('alert')).textContent).toContain('incomplete');
    expect(acceptInvite).not.toHaveBeenCalled();
  });
});

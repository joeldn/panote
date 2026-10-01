import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountMenu } from './AccountMenu.js';
import { SignInModal } from './SignInModal.js';

afterEach(cleanup);

const google = { id: 'google-oauth2', label: 'Google', icon: 'fa-brands fa-google' };

describe('SignInModal', () => {
  it('renders one button per option and starts that connection', async () => {
    const onSignIn = vi.fn(() => new Promise<void>(() => {}));
    render(<SignInModal open onClose={() => {}} options={[google]} onSignIn={onSignIn} />);
    expect(screen.getByRole('dialog', { name: 'Sign in to panote' })).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Continue with Google' });
    fireEvent.click(btn);
    expect(onSignIn).toHaveBeenCalledWith('google-oauth2');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms');
  });

  it('shows a failed start and lets the user retry', async () => {
    const onSignIn = vi.fn().mockRejectedValueOnce(new Error('popup blocked'));
    render(<SignInModal open onClose={() => {}} options={[google]} onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect((await screen.findByRole('alert')).textContent).toBe('popup blocked');
    const btn = screen.getByRole('button', { name: 'Continue with Google' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('re-enables the buttons when the page is restored from bfcache', () => {
    render(
      <SignInModal
        open
        onClose={() => {}}
        options={[google]}
        onSignIn={() => new Promise<void>(() => {})}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    const show = (persisted: boolean) =>
      act(() => {
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
      });
    show(false);
    expect(btn.disabled).toBe(true);
    show(true);
    expect(btn.disabled).toBe(false);
  });

  it('shows the unavailable message when no connection is enabled', () => {
    render(
      <SignInModal
        open
        onClose={() => {}}
        options={[]}
        onSignIn={vi.fn()}
        unavailable="Not set up"
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Not set up');
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
  });

  it('closes from the × button', () => {
    const onClose = vi.fn();
    render(<SignInModal open onClose={onClose} options={[google]} onSignIn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AccountMenu', () => {
  const user = { name: 'maya Larsson', email: 'maya@example.com' };

  it('shows the initial and opens a menu with name, email, links and sign-out', () => {
    render(
      <AccountMenu
        user={user}
        items={[{ label: 'My tours', icon: 'fa-solid fa-layer-group', href: '/app/' }]}
        onSignOut={() => {}}
      />,
    );
    const avatar = screen.getByRole('button', { name: 'Account: maya Larsson' });
    expect(avatar.textContent).toBe('M');
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(avatar);
    const menu = screen.getByRole('menu');
    expect(menu.textContent).toContain('maya@example.com');
    expect(screen.getByRole('menuitem', { name: 'My tours' }).getAttribute('href')).toBe('/app/');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });

  it('signs out and closes', () => {
    const onSignOut = vi.fn();
    render(<AccountMenu user={user} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and on an outside click', () => {
    render(<AccountMenu user={{ email: 'x@example.com' }} onSignOut={() => {}} />);
    const avatar = screen.getByRole('button', { name: 'Account: x@example.com' });
    expect(avatar.textContent).toBe('X');
    fireEvent.click(avatar);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(avatar);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

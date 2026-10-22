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

  it('renders every provider it is given, in order, with its brand icon', () => {
    const options = [
      google,
      { id: 'apple', label: 'Apple', icon: 'fa-brands fa-apple' },
      { id: 'windowslive', label: 'Microsoft', icon: 'fa-brands fa-microsoft' },
      { id: 'facebook', label: 'Facebook', icon: 'fa-brands fa-facebook' },
    ];
    const onSignIn = vi.fn(() => new Promise<void>(() => {}));
    render(<SignInModal open onClose={() => {}} options={options} onSignIn={onSignIn} />);
    const buttons = screen.getAllByRole('button', { name: /^Continue with / });
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Continue with Google',
      'Continue with Apple',
      'Continue with Microsoft',
      'Continue with Facebook',
    ]);
    expect(buttons.map((b) => b.querySelector('i')?.className)).toEqual(options.map((o) => o.icon));
    fireEvent.click(buttons[2]!);
    expect(onSignIn).toHaveBeenCalledWith('windowslive');
  });

  it('puts email below the social buttons, under an "or" divider, with a code hint', () => {
    const options = [
      { id: 'email', label: 'email', icon: 'fa-solid fa-envelope', kind: 'email' as const },
      google,
      { id: 'github', label: 'GitHub', icon: 'fa-brands fa-github', kind: 'social' as const },
      { id: 'linkedin', label: 'LinkedIn', icon: 'fa-brands fa-linkedin-in' },
    ];
    const onSignIn = vi.fn(() => new Promise<void>(() => {}));
    render(<SignInModal open onClose={() => {}} options={options} onSignIn={onSignIn} />);
    const buttons = screen.getAllByRole('button', { name: /^Continue with / });
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Continue with Google',
      'Continue with GitHub',
      'Continue with LinkedIn',
      'Continue with email',
    ]);
    const emailBtn = buttons[3]!;
    expect(emailBtn.className).toContain('pn-signin__option--email');
    expect(buttons.slice(0, 3).every((b) => !b.className.includes('--email'))).toBe(true);
    const divider = document.querySelector('.pn-signin__divider');
    expect(divider?.textContent).toBe('or');
    expect(divider!.compareDocumentPosition(buttons[2]!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(divider!.compareDocumentPosition(emailBtn)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const hint = screen.getByText('We’ll email you a one-time code.');
    expect(hint.id).not.toBe('');
    expect(emailBtn.getAttribute('aria-describedby')).toBe(hint.id);
    expect(buttons[0]!.hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(emailBtn);
    expect(onSignIn).toHaveBeenCalledWith('email');
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('shows email alone without a divider', () => {
    render(
      <SignInModal
        open
        onClose={() => {}}
        options={[{ id: 'email', label: 'email', icon: 'fa-solid fa-envelope', kind: 'email' }]}
        onSignIn={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy();
    expect(document.querySelector('.pn-signin__divider')).toBeNull();
  });

  it('shows no divider or code hint without an email option', () => {
    render(<SignInModal open onClose={() => {}} options={[google]} onSignIn={vi.fn()} />);
    expect(document.querySelector('.pn-signin__divider')).toBeNull();
    expect(screen.queryByText(/one-time code/)).toBeNull();
  });

  it('shows only the providers it is given', () => {
    render(<SignInModal open onClose={() => {}} options={[google]} onSignIn={vi.fn()} />);
    expect(
      screen.getAllByRole('button', { name: /^Continue with / }).map((b) => b.textContent),
    ).toEqual(['Continue with Google']);
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

  it('runs an action item, drawn as danger, and closes', () => {
    const onSelect = vi.fn();
    render(
      <AccountMenu
        user={user}
        items={[
          { label: 'Home page', icon: 'fa-solid fa-house', href: '/' },
          { label: 'Delete account', icon: 'fa-solid fa-trash', onSelect, danger: true },
        ]}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    const item = screen.getByRole('menuitem', { name: 'Delete account' });
    expect(item.tagName).toBe('BUTTON');
    expect(item.className).toContain('pn-account__item--danger');
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
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

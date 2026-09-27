import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmModal } from './ConfirmModal.js';
import { Modal, ModalHeader } from './Modal.js';

afterEach(cleanup);

describe('Modal', () => {
  it('renders nothing when closed and portals to body when open', () => {
    const { rerender, container } = render(
      <Modal open={false} onClose={() => {}} aria-label="Share">
        <p>inside</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <Modal open onClose={() => {}} aria-label="Share" width={560}>
        <p>inside</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Share' });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.className).toBe('pn-scrim');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.style.getPropertyValue('--pn-modal-width')).toBe('560px');
    expect(document.activeElement).toBe(dialog);
  });

  it('closes on Escape and on a scrim click, not on an inner click or a drag out', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} aria-label="x">
        <p>body</p>
      </Modal>,
    );
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(screen.getByText('body'));
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText('body'));
    fireEvent.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('can refuse scrim clicks', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} aria-label="x" closeOnScrim={false}>
        <p>body</p>
      </Modal>,
    );
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('labels via ModalHeader, traps Tab, and restores focus on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const ui = (open: boolean) => (
      <Modal open={open} onClose={onClose} labelledBy="t">
        <ModalHeader
          id="t"
          title="Share this tour"
          subtitle="Hall · last 14 days"
          onClose={onClose}
        />
        <button type="button">Copy</button>
      </Modal>
    );
    const { rerender } = render(ui(true));
    const dialog = screen.getByRole('dialog', { name: 'Share this tour' });
    const close = screen.getByRole('button', { name: 'Close' });
    const copy = screen.getByRole('button', { name: 'Copy' });
    copy.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(copy);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(ui(false));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('ConfirmModal', () => {
  it('focuses Cancel first and calls onConfirm / onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        open
        title="Delete this tour?"
        body="It can't be undone."
        confirmLabel="Delete tour"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Delete this tour?' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete tour' }).className).toContain(
      'pn-btn--danger',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete tour' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('stays busy while an async confirm runs and shows a failure', async () => {
    let reject!: (e: Error) => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_res, rej) => {
          reject = rej;
        }),
    );
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmModal
        open
        title="Delete?"
        body="b"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => reject(new Error('Delete failed, try again.')));
    expect(screen.getByRole('alert').textContent).toBe('Delete failed, try again.');
    expect(confirm).toHaveProperty('disabled', false);

    rerender(
      <ConfirmModal
        open={false}
        title="Delete?"
        body="b"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    rerender(
      <ConfirmModal open title="Delete?" body="b" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

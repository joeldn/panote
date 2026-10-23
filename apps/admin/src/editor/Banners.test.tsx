import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Notices } from './Banners.js';

afterEach(cleanup);

describe('Notices', () => {
  const restored = [
    { id: 'draft', tone: 'info' as const, text: 'Restored.', action: 'discard-draft' as const },
  ];
  const renderNotices = (saving: boolean) =>
    render(
      <MemoryRouter>
        <Notices
          notices={restored}
          onDismiss={vi.fn()}
          busy={false}
          onRepublish={vi.fn()}
          onDiscardDraft={vi.fn()}
          saving={saving}
          failed={false}
        />
      </MemoryRouter>,
    );

  it('offers Discard on a restored draft, and not while a save is under way', () => {
    renderNotices(false);
    expect(screen.getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(false);
    cleanup();
    renderNotices(true);
    expect(screen.getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers no publish Try again while a save runs or after one failed in part', () => {
    const notice = [
      { id: 'publish', tone: 'warn' as const, text: 'Not live.', action: 'republish' as const },
    ];
    const onRepublish = vi.fn();
    const renderWith = (saving: boolean, failed: boolean) =>
      render(
        <MemoryRouter>
          <Notices
            notices={notice}
            onDismiss={vi.fn()}
            busy={false}
            onRepublish={onRepublish}
            onDiscardDraft={vi.fn()}
            saving={saving}
            failed={failed}
          />
        </MemoryRouter>,
      );
    const tryAgain = () => screen.getByRole('button', { name: 'Try again' });

    renderWith(false, false);
    expect(tryAgain().hasAttribute('disabled')).toBe(false);
    fireEvent.click(tryAgain());
    expect(onRepublish).toHaveBeenCalledTimes(1);
    for (const [saving, failed] of [
      [true, false],
      [false, true],
    ] as const) {
      cleanup();
      renderWith(saving, failed);
      expect(tryAgain().hasAttribute('disabled')).toBe(true);
      fireEvent.click(tryAgain());
      expect(onRepublish).toHaveBeenCalledTimes(1);
    }
  });
});

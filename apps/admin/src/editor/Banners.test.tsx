import { cleanup, render, screen } from '@testing-library/react';
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
});

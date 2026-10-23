import { cleanup, render, screen } from '@testing-library/react';
import type { SharedTourSummary } from '@internal/contracts';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedTours } from './SharedTours.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');

const tour = (over: Partial<SharedTourSummary> = {}): SharedTourSummary => ({
  tourId: 'tour-9',
  title: 'Harbour walk',
  sceneCount: 3,
  coverPanoId: null,
  updatedAt: '2026-10-22T12:00:00Z',
  etag: 'e',
  publish: null,
  ownerEmail: 'maya@example.com',
  ...over,
});

const renderWith = (listSharedTours: () => Promise<{ tours: SharedTourSummary[] }>) =>
  render(
    <MemoryRouter>
      <SharedTours api={{ listSharedTours: vi.fn(listSharedTours) }} now={NOW} />
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('Shared with you', () => {
  it('lists each tour with its owner, linking to the editor', async () => {
    renderWith(async () => ({ tours: [tour()] }));
    const link = await screen.findByRole('link', { name: /Harbour walk/ });
    expect(link.getAttribute('href')).toBe('/t/tour-9');
    expect(link.textContent).toContain('maya@example.com · edited yesterday');
    expect(screen.getByRole('heading', { name: 'Shared with you' })).toBeTruthy();
  });

  it('shows nothing when no one shared a tour', async () => {
    const list = vi.fn(async () => ({ tours: [] }));
    const { container } = render(
      <MemoryRouter>
        <SharedTours api={{ listSharedTours: list }} now={NOW} />
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  it('says so when the list fails', async () => {
    renderWith(async () => {
      throw new Error('down');
    });
    expect((await screen.findByRole('status')).textContent).toContain('Couldn’t load');
  });
});

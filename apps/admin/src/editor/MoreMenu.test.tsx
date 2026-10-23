import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoreMenu } from './MoreMenu.js';

afterEach(cleanup);

function setup() {
  const onLanguages = vi.fn();
  const onSettings = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: '/t/t1',
        element: (
          <MoreMenu
            lang="de"
            langName="German"
            peopleTo="people"
            insightsTo="insights"
            onLanguages={onLanguages}
            onSettings={onSettings}
          />
        ),
      },
      { path: '/t/t1/insights', element: <p>Insights</p> },
      { path: '/t/t1/people', element: <p>People</p> },
    ],
    { initialEntries: ['/t/t1'] },
  );
  render(<RouterProvider router={router} />);
  return { onLanguages, onSettings, router };
}

const more = () => screen.getByRole('button', { name: 'Tour menu' });
const item = (name: RegExp | string) => screen.getByRole('menuitem', { name });

describe('MoreMenu', () => {
  it('opens on the tour’s occasional controls, focusing the first', () => {
    setup();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more());
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Tour settings',
      'Languagesde',
      'People',
      'Insights',
    ]);
    expect(document.activeElement).toBe(item('Tour settings'));
  });

  it('opens the language and settings popovers, closing itself', () => {
    const { onLanguages, onSettings } = setup();
    fireEvent.click(more());
    fireEvent.click(item('Languages, editing German'));
    expect(onLanguages).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more());
    fireEvent.click(item('Tour settings'));
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('links to Insights and People over the editor', () => {
    const { router } = setup();
    fireEvent.click(more());
    expect(item('Insights').getAttribute('href')).toBe('/t/t1/insights');
    fireEvent.click(item('People'));
    expect(router.state.location.pathname).toBe('/t/t1/people');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('walks its items with the arrow keys and closes on Escape, back to its button', () => {
    setup();
    fireEvent.click(more());
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Languages, editing German'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item('Insights'));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(item('Tour settings'));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('closes on a press outside it', () => {
    setup();
    fireEvent.click(more());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

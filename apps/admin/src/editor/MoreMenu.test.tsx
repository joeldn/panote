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
            previewTo="/t/t1/preview?lang=de"
            onLanguages={onLanguages}
            onSettings={onSettings}
          />
        ),
      },
      { path: '/t/t1/insights', element: <p>Insights</p> },
      { path: '/t/t1/preview', element: <p>Preview</p> },
    ],
    { initialEntries: ['/t/t1'] },
  );
  render(<RouterProvider router={router} />);
  return { onLanguages, onSettings, router };
}

const more = () => screen.getByRole('button', { name: 'More' });
const item = (name: RegExp | string) => screen.getByRole('menuitem', { name });

describe('MoreMenu', () => {
  it('opens on the bar’s controls that don’t fit, focusing the first', () => {
    setup();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more());
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Languagede',
      'Tour settings',
      'People',
      'Insights',
      'Preview',
    ]);
    expect(document.activeElement).toBe(item('Language: German'));
  });

  it('opens the language and settings popovers, closing itself', () => {
    const { onLanguages, onSettings } = setup();
    fireEvent.click(more());
    fireEvent.click(item('Language: German'));
    expect(onLanguages).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more());
    fireEvent.click(item('Tour settings'));
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('links to Insights and to Preview in the language being edited', () => {
    const { router } = setup();
    fireEvent.click(more());
    expect(item('Insights').getAttribute('href')).toBe('/t/t1/insights');
    fireEvent.click(item('Preview'));
    expect(router.state.location.pathname).toBe('/t/t1/preview');
    expect(router.state.location.search).toBe('?lang=de');
  });

  it('walks its items with the arrow keys and closes on Escape, back to its button', () => {
    setup();
    fireEvent.click(more());
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Tour settings'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item('Preview'));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(item('Language: German'));
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

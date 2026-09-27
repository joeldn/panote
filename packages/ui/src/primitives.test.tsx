import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button.js';
import { Chip } from './Chip.js';
import { Logo } from './Logo.js';
import { Segmented } from './Segmented.js';

afterEach(cleanup);

describe('Button', () => {
  it('renders variant/size classes and defaults to type=button', () => {
    render(
      <Button variant="danger" size="sm" pill icon="fa-solid fa-trash">
        Delete
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toBe('pn-btn pn-btn--danger pn-btn--sm pn-btn--pill');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.querySelector('i.fa-trash')).not.toBeNull();
  });

  it('is disabled with a spinner while busy', () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toHaveProperty('disabled', true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.querySelector('.pn-btn__spinner')).not.toBeNull();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Chip', () => {
  it('is a span by default and a button when clickable', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Chip icon="fa-solid fa-globe">Public</Chip>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Public').className).toBe('pn-chip pn-chip--dark');
    rerender(
      <Chip tone="accent" onClick={onClick} title="Click to change visibility">
        Unlisted
      </Chip>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unlisted' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Logo', () => {
  it('labels the mark with the wordmark and supports a mark-only form', () => {
    const { rerender } = render(<Logo />);
    expect(screen.getByRole('img', { name: 'panote.io' })).toBeTruthy();
    rerender(<Logo wordmark={false} size={32} accent="#000" />);
    const img = screen.getByRole('img', { name: 'panote' });
    const svg = img.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('#000');
    expect(img.textContent).toBe('');
  });
});

function Heights({ onChange }: { onChange?: (v: number) => void }) {
  const [v, setV] = useState(480);
  return (
    <Segmented
      aria-label="Height"
      value={v}
      onChange={(n) => {
        setV(n);
        onChange?.(n);
      }}
      options={[
        { value: 380, label: 'Compact' },
        { value: 480, label: 'Standard' },
        { value: 560, label: 'Disabled', disabled: true },
        { value: 660, label: 'Large' },
      ]}
    />
  );
}

describe('Segmented', () => {
  it('is a radiogroup with one checked, tabbable option', () => {
    render(<Heights />);
    expect(screen.getByRole('radiogroup', { name: 'Height' })).toBeTruthy();
    const std = screen.getByRole('radio', { name: 'Standard' });
    expect(std.getAttribute('aria-checked')).toBe('true');
    expect(std.tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'Compact' }).tabIndex).toBe(-1);
  });

  it('changes on click and with arrow keys, skipping disabled options', () => {
    const onChange = vi.fn();
    render(<Heights onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(onChange).toHaveBeenLastCalledWith(380);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Compact' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(660);
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Large' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Large' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(380);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Compact' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(480);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Standard' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(660);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Large' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(380);
  });

  it('renders tabs with aria-selected and aria-controls in tabs mode', () => {
    render(
      <Segmented
        kind="tabs"
        idPrefix="share"
        aria-label="Share"
        value="link"
        onChange={() => {}}
        options={[
          { value: 'link', label: 'Link' },
          { value: 'privacy', label: 'Privacy' },
          { value: 'embed', label: 'Embed' },
        ]}
      />,
    );
    const link = screen.getByRole('tab', { name: 'Link' });
    expect(screen.getByRole('tablist', { name: 'Share' })).toBeTruthy();
    expect(link.getAttribute('aria-selected')).toBe('true');
    expect(link.getAttribute('aria-controls')).toBe('share-panel-link');
    expect(link.id).toBe('share-tab-link');
    expect(link.hasAttribute('aria-checked')).toBe(false);
  });
});

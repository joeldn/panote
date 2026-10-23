import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button.js';
import { Chip } from './Chip.js';
import { IconButton } from './IconButton.js';
import { Logo } from './Logo.js';
import { Notice } from './Notice.js';
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

describe('Button variants', () => {
  it('has a bordered secondary and a text-only link variant', () => {
    render(
      <>
        <Button variant="secondary">Try again</Button>
        <Button variant="link" size="sm">
          Withdraw
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Try again' }).className).toBe(
      'pn-btn pn-btn--secondary',
    );
    expect(screen.getByRole('button', { name: 'Withdraw' }).className).toBe(
      'pn-btn pn-btn--link pn-btn--sm',
    );
  });
});

describe('IconButton', () => {
  it('is named by its label, with the icon hidden from screen readers', () => {
    const onClick = vi.fn();
    render(
      <IconButton icon="fa-solid fa-xmark" label="Dismiss" title="Dismiss" onClick={onClick} />,
    );
    const btn = screen.getByRole('button', { name: 'Dismiss' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.className).toBe('pn-icon-btn');
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('i.fa-xmark')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('takes a small size, extra classes and the props a menu button spreads', () => {
    render(
      <IconButton
        icon="fa-solid fa-ellipsis"
        label="More"
        size="sm"
        className="ed-conn__act"
        aria-haspopup="menu"
        aria-expanded={false}
        disabled
      />,
    );
    const btn = screen.getByRole('button', { name: 'More' });
    expect(btn.className).toBe('pn-icon-btn pn-icon-btn--sm ed-conn__act');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn).toHaveProperty('disabled', true);
  });
});

describe('Notice', () => {
  it('draws each tone and announces it to match', () => {
    render(
      <>
        <Notice>Finishing a delete…</Notice>
        <Notice tone="warn">Couldn’t load your tours.</Notice>
        <Notice tone="error" icon="fa-solid fa-triangle-exclamation">
          Some changes weren’t saved.
        </Notice>
      </>,
    );
    const info = screen.getByRole('status');
    expect(info.className).toBe('pn-notice pn-notice--info');
    const [warn, error] = screen.getAllByRole('alert');
    expect(warn?.className).toBe('pn-notice pn-notice--warn');
    expect(warn?.textContent).toBe('Couldn’t load your tours.');
    expect(error?.className).toBe('pn-notice pn-notice--error');
    expect(error?.querySelector('i.fa-triangle-exclamation')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('holds its actions and takes another role', () => {
    const onRetry = vi.fn();
    render(
      <Notice
        tone="warn"
        role="note"
        className="dash__notice"
        actions={<Button onClick={onRetry}>Try again</Button>}
      >
        Couldn’t load your panos.
      </Notice>,
    );
    const note = screen.getByRole('note');
    expect(note.className).toBe('pn-notice pn-notice--warn dash__notice');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
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
          { value: 'embed', label: 'Embed', disabled: true },
        ]}
      />,
    );
    const link = screen.getByRole('tab', { name: 'Link' });
    expect(screen.getByRole('tablist', { name: 'Share' })).toBeTruthy();
    expect(link.getAttribute('aria-selected')).toBe('true');
    expect(link.getAttribute('aria-controls')).toBe('share-panel-link');
    expect(link.id).toBe('share-tab-link');
    expect(link.hasAttribute('aria-checked')).toBe(false);
    // A disabled tab may have no panel: it points at none.
    expect(screen.getByRole('tab', { name: 'Embed' }).hasAttribute('aria-controls')).toBe(false);
  });
});

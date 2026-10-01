import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COPY_CONFIRM_MS } from '../constants.js';
import { embedSnippet, embedSrc, socialTargets, typingSlug } from './links.js';
import { ShareModal, type ShareModalProps } from './ShareModal.js';

const SITE = 'https://panote.test';
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderModal = (props: Partial<ShareModalProps> = {}) => {
  const all: ShareModalProps = {
    open: true,
    onClose: vi.fn(),
    siteOrigin: SITE,
    title: 'Old Town',
    slug: 'old-town',
    visibility: 'public',
    onCommitSlug: vi.fn(async () => {}),
    onVisibilityChange: vi.fn(async () => {}),
    currentPano: { id: 'pano-2', name: 'Courtyard' },
    ...props,
  };
  const view = render(<ShareModal {...all} />);
  return { ...view, props: all };
};

const editSlug = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Edit custom link' }));
  return screen.getByRole('textbox', { name: 'Custom link' }) as HTMLInputElement;
};

describe('share links', () => {
  it('builds the embed snippet in the design format with the env host', () => {
    expect(embedSnippet(embedSrc('https://panote.io/', 'st-lawrence-jewry'), 480)).toBe(
      '<iframe src="https://panote.io/s/st-lawrence-jewry/embed"\n' +
        '  width="100%" height="480" style="border:0"\n' +
        '  allow="fullscreen; xr-spatial-tracking"></iframe>',
    );
    expect(embedSrc(SITE, 'a-b', 'pano-1')).toBe(`${SITE}/s/a-b/embed?pano=pano-1`);
  });

  it('normalises while typing but keeps a dash to type through', () => {
    expect(typingSlug('My Tour!')).toBe('my-tour-');
    expect(typingSlug('--Café  au lait')).toBe('caf-au-lait');
    expect(typingSlug('x'.repeat(60))).toHaveLength(40);
  });

  it('encodes the URL and title into the four social intents', () => {
    const targets = socialTargets(`${SITE}/s/a-b`, 'A & B');
    expect(targets.map((t) => t.label)).toEqual(['X', 'Facebook', 'LinkedIn', 'WhatsApp']);
    expect(targets[0]?.href).toBe(
      'https://twitter.com/intent/tweet?url=https%3A%2F%2Fpanote.test%2Fs%2Fa-b&text=A%20%26%20B',
    );
  });
});

describe('ShareModal', () => {
  it('shows the banner, three tabs and the link with the env host', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Share this tour' });
    expect(within(dialog).getByText('Public').closest('.pn-share__banner')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Link',
      'Privacy',
      'Embed',
    ]);
    expect(screen.getByRole('status', { name: 'Share link' }).textContent).toBe(
      'panote.test/s/old-town',
    );
    const x = screen.getByRole('link', { name: 'Share on X' });
    expect(x.getAttribute('target')).toBe('_blank');
    expect(x.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('copies the full link and flips the label for 1.6s', async () => {
    vi.useFakeTimers();
    renderModal();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })));
    expect(writeText).toHaveBeenCalledWith(`${SITE}/s/old-town`);
    expect(screen.getByRole('button', { name: 'Copied ✓' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(COPY_CONFIRM_MS));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('reports a failed clipboard write instead of claiming success', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderModal();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })));
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy();
  });

  describe('custom slug', () => {
    it('normalises the draft and commits it on Enter', async () => {
      const { props } = renderModal();
      const input = editSlug();
      expect(input.value).toBe('old-town');
      fireEvent.change(input, { target: { value: 'New Town!' } });
      expect(input.value).toBe('new-town-');
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(props.onCommitSlug).toHaveBeenCalledExactlyOnceWith('new-town');
      expect(screen.queryByRole('textbox', { name: 'Custom link' })).toBeNull();
    });

    it('commits on blur', async () => {
      const { props } = renderModal();
      const input = editSlug();
      fireEvent.change(input, { target: { value: 'harbour-walk' } });
      await act(async () => fireEvent.blur(input));
      expect(props.onCommitSlug).toHaveBeenCalledExactlyOnceWith('harbour-walk');
    });

    it('cancels on Escape without closing the modal or saving', async () => {
      const { props } = renderModal();
      const input = editSlug();
      fireEvent.change(input, { target: { value: 'something-else' } });
      await act(async () => fireEvent.keyDown(input, { key: 'Escape' }));
      expect(props.onClose).not.toHaveBeenCalled();
      expect(props.onCommitSlug).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Edit custom link' }).textContent).toContain(
        'old-town',
      );
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('does not call the API for an unchanged slug', async () => {
      const { props } = renderModal();
      const input = editSlug();
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(props.onCommitSlug).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it.each([
      ['ab', 'Use 3–40 lowercase letters'],
      ['admin', 'That link is reserved'],
    ])('rejects %s inline without saving', async (value, message) => {
      const { props } = renderModal();
      const input = editSlug();
      fireEvent.change(input, { target: { value } });
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(props.onCommitSlug).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toContain(message);
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    it('shows a 409 inline and keeps editing; the same draft is not re-sent on blur', async () => {
      const onCommitSlug = vi.fn(async () => {
        throw new Error('That link is already taken.');
      });
      renderModal({ onCommitSlug });
      const input = editSlug();
      fireEvent.change(input, { target: { value: 'taken-one' } });
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(screen.getByRole('alert').textContent).toBe('That link is already taken.');
      expect(screen.getByRole('textbox', { name: 'Custom link' })).toBe(input);
      await act(async () => fireEvent.blur(input));
      expect(onCommitSlug).toHaveBeenCalledTimes(1);
    });
  });

  describe('privacy', () => {
    it('offers exactly two options and patches the choice', async () => {
      const { props } = renderModal({ tab: 'privacy' });
      const radios = within(screen.getByRole('radiogroup')).getAllByRole('radio');
      expect(radios.map((r) => r.querySelector('.pn-share__option-title')?.textContent)).toEqual([
        'Public',
        'Unlisted',
      ]);
      expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
      await act(async () => fireEvent.click(radios[1]!));
      expect(props.onVisibilityChange).toHaveBeenCalledExactlyOnceWith('unlisted');
      await act(async () => fireEvent.click(radios[0]!));
      expect(props.onVisibilityChange).toHaveBeenCalledTimes(1);
    });

    it('shows a failed change inline', async () => {
      renderModal({
        tab: 'privacy',
        onVisibilityChange: () => Promise.reject(new Error('Try again.')),
      });
      await act(async () => fireEvent.click(screen.getByRole('radio', { name: /Unlisted/ })));
      expect(screen.getByRole('alert').textContent).toBe('Try again.');
    });
  });

  describe('embed', () => {
    const code = () => screen.getByLabelText('Embed code', { selector: 'pre' }).textContent;

    it('builds the snippet from scope and height, and copies it', async () => {
      renderModal({ tab: 'embed' });
      expect(code()).toBe(embedSnippet(`${SITE}/s/old-town/embed`, 480));
      fireEvent.click(screen.getByRole('radio', { name: /This pano only/ }));
      fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
      expect(code()).toBe(embedSnippet(`${SITE}/s/old-town/embed?pano=pano-2`, 660));
      expect(screen.getByText('Courtyard — no links out')).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy code' })));
      expect(writeText).toHaveBeenCalledWith(code());
    });

    it('disables "This pano only" without a current pano', () => {
      renderModal({ tab: 'embed', currentPano: null });
      expect(
        (screen.getByRole('radio', { name: /This pano only/ }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('previews the embed in a same-site iframe on request', () => {
      renderModal({ tab: 'embed' });
      expect(screen.queryByTitle('Embed preview')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      const frame = screen.getByTitle('Embed preview');
      expect(frame.getAttribute('src')).toBe(`${SITE}/s/old-town/embed`);
      expect(frame.getAttribute('height')).toBe('480');
    });
  });

  it('switches tabs through onTabChange', () => {
    const onTabChange = vi.fn();
    renderModal({ tab: 'link', onTabChange });
    fireEvent.click(screen.getByRole('tab', { name: 'Embed' }));
    expect(onTabChange).toHaveBeenCalledWith('embed');
  });

  it('offers to publish an unpublished tour', async () => {
    const onPublish = vi.fn(async () => {});
    renderModal({ slug: null, onPublish });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByText('This tour isn’t live yet')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish link' })));
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it('asks for a new slug when publish lost the old one', async () => {
    const { props } = renderModal({ slug: null, slugRequired: true, notice: 'Pick a new link.' });
    expect(screen.getByText('Pick a new link.')).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Custom link' });
    fireEvent.change(input, { target: { value: 'fresh-link' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(props.onCommitSlug).toHaveBeenCalledWith('fresh-link');
  });

  it('gives visitors the link only: no tabs, banner or slug edit', () => {
    renderModal({ variant: 'visitor', tab: 'embed' });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit custom link' })).toBeNull();
    expect(screen.queryByText('This tour is')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});

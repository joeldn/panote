import { buildShareUrls, SHARE_PLATFORMS, type ShareData } from './share.js';

export interface ShareHandle {
  /** Open the native share sheet if available, else the popover. */
  open(): void;
  remove(): void;
}

function resolveData(data: ShareData): Required<ShareData> {
  const url = data.url ?? (typeof location !== 'undefined' ? location.href : '');
  const title = data.title ?? document.title ?? '';
  return { url, title, text: data.text ?? title };
}

function iconButton(label: string, html: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = html;
  b.style.cssText =
    'display:flex;align-items:center;gap:10px;width:100%;text-align:left;' +
    'background:none;border:none;color:#fff;font:13px/1 system-ui,sans-serif;' +
    'padding:9px 10px;border-radius:6px;cursor:pointer;';
  b.onpointerenter = () => (b.style.background = 'rgba(255,255,255,.12)');
  b.onpointerleave = () => (b.style.background = 'none');
  return b;
}

/**
 * Build a popover element listing each social platform plus "Copy link".
 * Caller positions it; `toggle()` shows/hides. Closes on outside click / Esc.
 */
export function createSharePopover(data: ShareData): {
  el: HTMLElement;
  toggle: () => void;
  close: () => void;
} {
  const pop = document.createElement('div');
  pop.setAttribute('role', 'menu');
  pop.style.cssText =
    'position:absolute;right:0;bottom:48px;display:none;flex-direction:column;gap:2px;' +
    'min-width:170px;padding:6px;background:rgba(20,20,20,.92);border-radius:10px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.5);backdrop-filter:blur(8px);z-index:30;' +
    'pointer-events:auto;';

  const urls = buildShareUrls(resolveData(data));
  for (const p of SHARE_PLATFORMS) {
    const item = iconButton(`Share on ${p.label}`, `${p.icon}<span>${p.label}</span>`);
    item.onclick = () => {
      window.open(urls[p.id], '_blank', 'noopener,noreferrer,width=600,height=520');
      close();
    };
    pop.appendChild(item);
  }

  // Copy-link action with transient "Copied!" feedback.
  const copyIcon =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const copy = iconButton('Copy link', `${copyIcon}<span>Copy link</span>`);
  copy.onclick = () => {
    const label = copy.querySelector('span');
    const { url } = resolveData(data);
    const done = () => {
      if (label) label.textContent = 'Copied!';
      setTimeout(() => {
        if (label) label.textContent = 'Copy link';
      }, 1400);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).then(done, done);
    } else {
      done();
    }
  };
  pop.appendChild(copy);

  const onDocPointer = (e: Event) => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  function open() {
    pop.style.display = 'flex';
    // Defer so the click that opened us doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocPointer);
      document.addEventListener('keydown', onKey);
    });
  }
  function close() {
    pop.style.display = 'none';
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onKey);
  }
  function toggle() {
    if (pop.style.display === 'none') open();
    else close();
  }

  return { el: pop, toggle, close };
}

import type { PanoViewer } from '../PanoViewer.js';
import { createSharePopover } from './share-ui.js';
import type { ShareData } from './share.js';

export interface ControlsHandle {
  remove(): void;
}

export interface ControlsOptions {
  /**
   * Social-share button config. Pass `false` to omit it; pass a `ShareData`
   * object to customise the link/title/text. Defaults to sharing the current
   * page with its document title.
   */
  share?: ShareData | false;
}

const ICON_EXPAND =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h3M16 7V4h-3M4 13v3h3M16 13v3h-3"/></svg>';
const ICON_COLLAPSE =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4v3H4M13 4v3h3M7 16v-3H4M13 16v-3h3"/></svg>';

function button(label: string, svg: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = svg;
  b.style.cssText =
    'width:40px;height:40px;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(20,20,20,.6);color:#fff;border:none;border-radius:8px;cursor:pointer;' +
    'backdrop-filter:blur(4px);pointer-events:auto;';
  return b;
}

export function mountControls(
  viewer: PanoViewer,
  container: HTMLElement,
  opts: ControlsOptions = {},
): ControlsHandle {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;z-index:10;' +
    'pointer-events:none;';
  const zin = button(
    'Zoom in',
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4v12M4 10h12"/></svg>',
  );
  const zout = button(
    'Zoom out',
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10h12"/></svg>',
  );
  const full = button('Fullscreen', ICON_EXPAND);

  const zoomBy = (s: number) => viewer.setView({ fov: viewer.getView().fov * s });
  zin.onclick = () => zoomBy(0.8);
  zout.onclick = () => zoomBy(1.25);

  // Grey out a zoom button once the view is clamped at that end of the fov
  // range, so "can't zoom further" reads visually. Smaller fov = zoomed in.
  const { min: minFov, max: maxFov } = viewer.getFovLimits();
  const setEnabled = (b: HTMLButtonElement, enabled: boolean) => {
    b.disabled = !enabled;
    b.style.opacity = enabled ? '1' : '0.4';
    b.style.cursor = enabled ? 'pointer' : 'default';
  };
  const syncZoom = () => {
    const fov = viewer.getView().fov;
    setEnabled(zin, fov > minFov + 1e-3); // room to zoom in
    setEnabled(zout, fov < maxFov - 1e-3); // room to zoom out
  };
  const unsubZoom = viewer.onRender(syncZoom);
  syncZoom();
  full.onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.requestFullscreen();
  };
  // Keep the fullscreen icon in sync with actual state (Esc, F11, etc.).
  const onFsChange = () => {
    const active = document.fullscreenElement === container;
    full.innerHTML = active ? ICON_COLLAPSE : ICON_EXPAND;
    full.title = active ? 'Exit fullscreen' : 'Fullscreen';
    full.setAttribute('aria-label', full.title);
  };
  document.addEventListener('fullscreenchange', onFsChange);

  bar.append(zin, zout, full);

  // Share: native sheet on mobile, popover everywhere else.
  let shareCleanup: (() => void) | undefined;
  if (opts.share !== false) {
    const data: ShareData = opts.share ?? {};
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;pointer-events:auto;';
    const share = button(
      'Share',
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="15" cy="4" r="2"/><circle cx="5" cy="10" r="2"/><circle cx="15" cy="16" r="2"/><path d="M7 9l6-3.5M7 11l6 3.5"/></svg>',
    );
    const popover = createSharePopover(data);
    // Native share sheet is great on touch devices but clumsy on desktop
    // (where it exists but defers to OS dialogs), so reserve it for coarse
    // pointers and give everyone else the in-page popover.
    const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    share.onclick = () => {
      const nav = navigator as Navigator & {
        share?: (d: ShareData) => Promise<void>;
      };
      if (isTouch && nav.share) {
        const payload: ShareData = {
          url: data.url ?? location.href,
          title: data.title ?? document.title,
          ...(data.text !== undefined && { text: data.text }),
        };
        void nav.share(payload).catch(() => popover.toggle());
      } else {
        popover.toggle();
      }
    };
    wrap.append(popover.el, share);
    bar.append(wrap);
    shareCleanup = () => popover.close();
  }

  container.appendChild(bar);
  return {
    remove: () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      unsubZoom();
      shareCleanup?.();
      bar.remove();
    },
  };
}

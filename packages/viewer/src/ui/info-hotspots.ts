import type { PanoViewer } from '../PanoViewer.js';
import type { HotspotHandle } from '../hotspots.js';
import { renderMarkdown } from './markdown.js';

export interface InfoHotspotData {
  yaw: number; // radians
  pitch: number; // radians
  title: string;
  /** Markdown body shown in the panel when the hotspot is opened. */
  body?: string;
  /** Optional short caption shown under the title. */
  subtitle?: string;
}

export interface InfoHotspotsHandle {
  remove(): void;
}

const PANEL_CLASS = 'pano-info-panel';
let stylesInjected = false;

// Inject panel/marker prose styles once. Scoped by class so they only affect
// the info panel's rendered Markdown, not the embedder's page.
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.${PANEL_CLASS} h1,.${PANEL_CLASS} h2,.${PANEL_CLASS} h3{margin:.6em 0 .3em;line-height:1.25}
.${PANEL_CLASS} h1{font-size:1.4em}.${PANEL_CLASS} h2{font-size:1.2em}.${PANEL_CLASS} h3{font-size:1.05em}
.${PANEL_CLASS} p{margin:.5em 0}
.${PANEL_CLASS} ul,.${PANEL_CLASS} ol{margin:.5em 0;padding-left:1.3em}
.${PANEL_CLASS} li{margin:.2em 0}
.${PANEL_CLASS} a{color:#7db8ff}
.${PANEL_CLASS} code{background:rgba(255,255,255,.12);padding:.1em .35em;border-radius:4px;font-size:.9em}
.${PANEL_CLASS}::-webkit-scrollbar{width:8px}
.${PANEL_CLASS}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:4px}`;
  document.head.appendChild(style);
}

function makeMarker(title: string): {
  wrap: HTMLDivElement;
  btn: HTMLButtonElement;
} {
  // The viewer positions this wrapper every frame via its `transform`, so the
  // wrapper must carry NO transform transition or the marker eases (lags)
  // behind the scene during pan and looks unanchored. The hover-scale lives on
  // the inner button, whose `transform` the viewer never touches.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;pointer-events:none;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', title);
  btn.title = title;
  btn.style.cssText =
    'position:relative;width:30px;height:30px;border-radius:50%;border:2px solid rgba(255,255,255,.9);' +
    'background:rgba(20,20,20,.55);color:#fff;font:700 16px/1 Georgia,serif;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;pointer-events:auto;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.5);backdrop-filter:blur(3px);transition:transform .12s ease;';
  btn.innerHTML = 'i';
  // Pulsing ring to draw the eye.
  const ring = document.createElement('span');
  ring.style.cssText =
    'position:absolute;inset:-2px;border-radius:50%;border:2px solid rgba(255,255,255,.7);' +
    'animation:pano-pulse 2s ease-out infinite;pointer-events:none;';
  btn.appendChild(ring);
  btn.onpointerenter = () => (btn.style.transform = 'scale(1.15)');
  btn.onpointerleave = () => (btn.style.transform = 'scale(1)');

  wrap.appendChild(btn);
  return { wrap, btn };
}

interface Panel {
  open(data: InfoHotspotData): void;
  close(): void;
  remove(): void;
}

// A single sliding side-panel shared by all hotspots in a viewer.
function createPanel(container: HTMLElement): Panel {
  injectStyles();
  if (!document.getElementById('pano-pulse-kf')) {
    const kf = document.createElement('style');
    kf.id = 'pano-pulse-kf';
    kf.textContent =
      '@keyframes pano-pulse{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.8);opacity:0}}';
    document.head.appendChild(kf);
  }

  const scrim = document.createElement('div');
  scrim.style.cssText =
    'position:absolute;inset:0;background:rgba(0,0,0,.35);opacity:0;transition:opacity .25s ease;' +
    'pointer-events:none;z-index:24;';

  const panel = document.createElement('aside');
  panel.className = PANEL_CLASS;
  panel.style.cssText =
    'position:absolute;top:0;right:0;bottom:0;width:min(360px,86%);box-sizing:border-box;' +
    'padding:20px 22px 28px;overflow:auto;color:#f3f3f3;font:15px/1.5 system-ui,sans-serif;' +
    'background:rgba(18,18,20,.9);backdrop-filter:blur(10px);box-shadow:-8px 0 28px rgba(0,0,0,.45);' +
    'transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);z-index:25;' +
    'pointer-events:auto;';

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  close.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l10 10M15 5L5 15"/></svg>';
  close.style.cssText =
    'position:absolute;top:14px;right:14px;width:32px;height:32px;border:none;border-radius:8px;' +
    'background:rgba(255,255,255,.1);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;';

  const header = document.createElement('div');
  header.style.cssText = 'margin:4px 40px 14px 0;';
  const titleEl = document.createElement('h2');
  titleEl.style.cssText = 'margin:0;font-size:1.35em;line-height:1.2;';
  const subEl = document.createElement('div');
  subEl.style.cssText = 'margin-top:4px;color:#aaa;font-size:.85em;';
  header.append(titleEl, subEl);

  const bodyEl = document.createElement('div');

  panel.append(close, header, bodyEl);
  container.append(scrim, panel);

  let isOpen = false;
  const doClose = () => {
    if (!isOpen) return;
    isOpen = false;
    panel.style.transform = 'translateX(100%)';
    scrim.style.opacity = '0';
    scrim.style.pointerEvents = 'none';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') doClose();
  };
  close.onclick = doClose;
  scrim.onclick = doClose;

  return {
    open(data) {
      titleEl.textContent = data.title;
      if (data.subtitle) {
        subEl.textContent = data.subtitle;
        subEl.style.display = 'block';
      } else {
        subEl.style.display = 'none';
      }
      bodyEl.innerHTML = renderMarkdown(data.body ?? '');
      panel.scrollTop = 0;
      isOpen = true;
      panel.style.transform = 'translateX(0)';
      scrim.style.opacity = '1';
      scrim.style.pointerEvents = 'auto';
      document.addEventListener('keydown', onKey);
    },
    close: doClose,
    remove() {
      document.removeEventListener('keydown', onKey);
      scrim.remove();
      panel.remove();
    },
  };
}

/**
 * Anchor info markers in the scene. Clicking one opens a sliding panel showing
 * its title and Markdown description. Returns a handle to remove them all.
 */
export function mountInfoHotspots(
  viewer: PanoViewer,
  spots: InfoHotspotData[],
): InfoHotspotsHandle {
  const panel = createPanel(viewer.el);
  const handles: HotspotHandle[] = [];

  for (const spot of spots) {
    const { wrap, btn } = makeMarker(spot.title);
    btn.onclick = () => panel.open(spot);
    const handle = viewer.addHotspot(wrap, {
      yaw: spot.yaw,
      pitch: spot.pitch,
    });
    handles.push(handle);
  }

  return {
    remove() {
      for (const h of handles) h.remove();
      panel.remove();
    },
  };
}

import type { PanoViewer } from '../PanoViewer.js';
import { arrivalView, type Tour, type TourLink } from './tour.js';

const PITCH_NEAR = -0.6; // closer to the viewer's feet
const PITCH_FAR = -0.2; // further along, toward the horizon

function makeChevron(link: TourLink): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', link.label ? `Go to ${link.label}` : 'Move here');
  if (link.label) btn.title = link.label;
  btn.style.cssText =
    'position:absolute;left:0;top:0;border:none;background:none;padding:0;cursor:pointer;' +
    'pointer-events:auto;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));' +
    'transition:filter .15s ease;';
  btn.innerHTML =
    '<svg width="48" height="48" viewBox="0 0 48 48" fill="rgba(255,255,255,.92)" stroke="rgba(0,0,0,.35)" stroke-width="1.5">' +
    '<path d="M24 8 L40 30 H30 V40 H18 V30 H8 Z"/></svg>';
  btn.onpointerenter = () => (btn.style.filter = 'drop-shadow(0 0 6px rgba(255,255,255,.8))');
  btn.onpointerleave = () => (btn.style.filter = 'drop-shadow(0 2px 3px rgba(0,0,0,.6))');
  btn.style.display = 'none';
  return btn;
}

export interface Navigator {
  go(to: string): void;
  current(): string;
  remove(): void;
}

export function mountNavArrows(viewer: PanoViewer, tour: Tour): Navigator {
  let scene = tour.start;
  let transitioning = false;

  // Track { link, btn } pairs for per-frame updates.
  let buttons: Array<{ link: TourLink; btn: HTMLButtonElement }> = [];

  const unsubscribe = viewer.onRender(() => {
    if (transitioning) return;
    for (const { link, btn } of buttons) {
      const near = viewer.project(link.yaw, PITCH_NEAR);
      const far = viewer.project(link.yaw, PITCH_FAR);
      if (near.behind) {
        btn.style.display = 'none';
        continue;
      }
      btn.style.display = 'block';
      const cx = (near.x + far.x) / 2;
      const cy = (near.y + far.y) / 2;
      const dx = far.x - near.x;
      const dy = far.y - near.y;
      // angle to rotate an UP-pointing chevron so it points from near toward far
      const angleDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      // foreshorten: bigger when the path runs toward us, smaller when side-on/far
      const len = Math.hypot(dx, dy);
      const scale = Math.max(0.5, Math.min(1.5, len / 90));
      btn.style.transform = `translate(-50%,-50%) translate(${cx}px,${cy}px) rotate(${angleDeg}deg) scale(${scale})`;
    }
  });

  const render = () => {
    // Remove old buttons.
    for (const { btn } of buttons) btn.remove();
    buttons = [];

    const links = tour.scenes[scene]?.links ?? [];
    for (const link of links) {
      const btn = makeChevron(link);
      btn.onclick = () => go(link.to);
      viewer.el.appendChild(btn);
      buttons.push({ link, btn });
    }
  };

  const go = (to: string) => {
    const from = scene;
    const link = tour.scenes[scene]?.links.find((l) => l.to === to);
    scene = to;
    // Hide all buttons while transitioning.
    transitioning = true;
    for (const { btn } of buttons) btn.style.display = 'none';
    void viewer
      .transitionTo(to, link ? arrivalView(link) : undefined)
      .catch(() => {
        // load() rejects if the target panorama has no manifest or no
        // low-resolution base layer, and PanoViewer leaves the previous
        // panorama on screen when it does. Snap the tour back to the scene
        // actually being shown, so the arrows match it — and so a failed jump
        // does not strand the navigation hidden forever.
        scene = from;
      })
      .finally(() => {
        transitioning = false;
        render();
      });
  };

  render();

  return {
    go,
    current: () => scene,
    remove: () => {
      unsubscribe();
      for (const { btn } of buttons) btn.remove();
      buttons = [];
    },
  };
}

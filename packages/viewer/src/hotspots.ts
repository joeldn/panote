import { dirFromYawPitch, isBehind, ndcToPixel } from './project.js';
import { projectDir, type Mat4 } from './render/projection.js';

export interface Hotspot {
  el: HTMLElement;
  yaw: number;
  pitch: number;
}
export interface HotspotHandle {
  remove(): void;
  update(pos: { yaw?: number; pitch?: number }): void;
}

export class HotspotLayer {
  private spots = new Set<Hotspot>();

  add(el: HTMLElement, yaw: number, pitch: number): HotspotHandle {
    const spot: Hotspot = { el, yaw, pitch };
    this.spots.add(spot);
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.willChange = 'transform';
    return {
      remove: () => {
        this.spots.delete(spot);
        el.remove();
      },
      update: (p) => {
        if (p.yaw !== undefined) spot.yaw = p.yaw;
        if (p.pitch !== undefined) spot.pitch = p.pitch;
      },
    };
  }

  update(viewProj: Mat4, fwd: { x: number; y: number; z: number }, w: number, h: number): void {
    for (const s of this.spots) {
      const d = dirFromYawPitch(s.yaw, s.pitch);
      if (isBehind(d, fwd)) {
        s.el.style.visibility = 'hidden';
        continue;
      }
      const ndc = projectDir(d, viewProj);
      const { x, y } = ndcToPixel(ndc.x, ndc.y, w, h);
      s.el.style.visibility = 'visible';
      // center the element on the projected point
      s.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    }
  }

  clear(): void {
    for (const s of this.spots) s.el.remove();
    this.spots.clear();
  }
}

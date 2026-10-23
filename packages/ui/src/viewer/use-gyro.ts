import type { PanoViewerApi } from '@panote/viewer';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { lookFromOrientation, screenAngle, smoothLook, yawFor, type Look } from './gyro.js';

/** Share of the way each reading moves toward the new one; the viewer eases on top. */
const SMOOTHING = 0.35;
/**
 * With no reading this long after turning on, it goes off again. The control stays: the
 * sensor may just have been slow, so another tap tries again.
 */
const NO_READINGS_MS = 1500;

type PermissionRequest = () => Promise<'granted' | 'denied' | 'default'>;

/** iOS 13+ asks before giving a page motion readings, and only from a tap. */
const permissionRequest = (): PermissionRequest | null => {
  const ctor = (globalThis as { DeviceOrientationEvent?: { requestPermission?: unknown } })
    .DeviceOrientationEvent;
  return typeof ctor?.requestPermission === 'function'
    ? (ctor.requestPermission.bind(ctor) as PermissionRequest)
    : null;
};

/**
 * Offered on a touch device whose browser has the event. A desktop browser has it too
 * but never fires it, hence the coarse pointer.
 */
export function gyroSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent === 'function' &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches
  );
}

export interface Gyro {
  /** Whether to show the control at all. */
  available: boolean;
  on: boolean;
  /** Call from the tap itself: iOS only asks for permission inside one. */
  toggle: () => void;
}

/**
 * "Tilt to look around": while on, the phone's orientation steers the camera. The
 * heading is relative (it starts from where the camera faces), the pitch absolute
 * (holding the phone upright looks at the horizon). A drag or a key on the viewer
 * turns it off, as does a device or embed that gives no readings. A refused permission
 * hides the control. `stage` is the element whose viewer the visitor drags.
 */
export function useGyro(viewer: PanoViewerApi | null, stage: RefObject<HTMLElement | null>): Gyro {
  const [supported] = useState(gyroSupported);
  const [failed, setFailed] = useState(false);
  const [on, setOn] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!on || !viewer) return;
    let offset: number | null = null;
    let smoothed: Look | null = null;
    let readings = false;
    const silent = setTimeout(() => {
      if (!readings) setOn(false);
    }, NO_READINGS_MS);
    const onOrientation = (e: DeviceOrientationEvent) => {
      const look = lookFromOrientation(e, screenAngle());
      if (!look) return;
      readings = true;
      smoothed = smoothLook(smoothed, look, SMOOTHING);
      offset ??= viewer.getView().yaw - smoothed.heading;
      viewer.setView({ yaw: yawFor(smoothed, offset), pitch: smoothed.pitch });
    };
    // A turned screen changes which way is up: start again from the camera as it is.
    const reanchor = () => {
      offset = null;
      smoothed = null;
    };
    const off = () => setOn(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key.startsWith('Arrow')) off();
    };
    const host = stage.current?.querySelector('.pn-stage__viewer') ?? null;
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('orientationchange', reanchor);
    screen.orientation?.addEventListener?.('change', reanchor);
    host?.addEventListener('pointerdown', off);
    host?.addEventListener('keydown', onKey as EventListener);
    return () => {
      clearTimeout(silent);
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('orientationchange', reanchor);
      screen.orientation?.removeEventListener?.('change', reanchor);
      host?.removeEventListener('pointerdown', off);
      host?.removeEventListener('keydown', onKey as EventListener);
    };
  }, [on, viewer, stage]);

  const toggle = () => {
    if (on) {
      setOn(false);
      return;
    }
    const ask = permissionRequest();
    if (!ask) {
      setOn(true);
      return;
    }
    if (pending.current) return;
    pending.current = true;
    ask().then(
      (state) => {
        pending.current = false;
        if (state === 'granted') setOn(true);
        // Refused: Safari won't ask again until it restarts, so the control goes.
        else setFailed(true);
      },
      () => {
        pending.current = false;
        setFailed(true);
      },
    );
  };

  return { available: supported && !failed, on, toggle };
}

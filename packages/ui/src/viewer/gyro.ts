/**
 * Phone orientation to a look direction, for "tilt to look around". Pure, so the
 * maths is tested without a device.
 *
 * Frames, as the DeviceOrientation spec defines them: the earth's x points east,
 * y north and z up; the device's x points to the right of the screen in its
 * natural orientation, y to its top and z out of the screen at the person
 * holding it. alpha, beta and gamma (degrees) rotate the device frame into the
 * earth's as Rz(alpha) Rx(beta) Ry(gamma).
 */

const DEG = Math.PI / 180;

export interface DeviceAngles {
  /** Degrees about z (counterclockwise seen from above); may be null on a device without it. */
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}

/** Where the camera looks: compass heading (radians, clockwise from north) and pitch (radians, up). */
export interface Look {
  heading: number;
  pitch: number;
}

type Vec3 = [number, number, number];

/** Rz(alpha) Rx(beta) Ry(gamma) applied to `v` (device frame to earth frame). */
function toEarth(alpha: number, beta: number, gamma: number, v: Vec3): Vec3 {
  const [ca, sa] = [Math.cos(alpha), Math.sin(alpha)];
  const [cb, sb] = [Math.cos(beta), Math.sin(beta)];
  const [cg, sg] = [Math.cos(gamma), Math.sin(gamma)];
  // Ry(gamma)
  const x1 = cg * v[0] + sg * v[2];
  const y1 = v[1];
  const z1 = -sg * v[0] + cg * v[2];
  // Rx(beta)
  const x2 = x1;
  const y2 = cb * y1 - sb * z1;
  const z2 = sb * y1 + cb * z1;
  // Rz(alpha)
  return [ca * x2 - sa * y2, sa * x2 + ca * y2, z2];
}

/**
 * The direction the back of the phone points, as a heading and pitch, for a
 * screen turned `screenAngle` degrees (`screen.orientation.angle`: 90 is the
 * device turned a quarter counterclockwise into landscape). Null without readings.
 *
 * No Euler angles are read back, so there is no gimbal lock: the heading comes
 * from the forward vector near the horizon and from the screen's up vector
 * towards straight up or down, blended by the pitch, which stays well defined
 * at the poles (looking down, the top of the screen points the way you face).
 */
export function lookFromOrientation(angles: DeviceAngles, screenAngle = 0): Look | null {
  const { alpha, beta, gamma } = angles;
  if (beta === null || gamma === null) return null;
  const a = (alpha ?? 0) * DEG;
  const b = beta * DEG;
  const g = gamma * DEG;
  const s = screenAngle * DEG;
  // Out of the back of the screen, and the screen's up as the person sees it.
  const forward = toEarth(a, b, g, [0, 0, -1]);
  const up = toEarth(a, b, g, [Math.sin(s), Math.cos(s), 0]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward[2])));
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // For a camera with no roll, forward_h = cos(p)·H and up_h = −sin(p)·H, so this is H.
  const east = cp * forward[0] - sp * up[0];
  const north = cp * forward[1] - sp * up[1];
  return { heading: Math.atan2(east, north), pitch };
}

/** `angle` wrapped into (−π, π]. */
export function wrapAngle(angle: number): number {
  const t = Math.PI * 2;
  const w = ((angle % t) + t) % t;
  return w > Math.PI ? w - t : w;
}

/**
 * One step of a low-pass filter: `k` (0..1] of the way from `prev` to `next`,
 * taking the heading the short way round. `prev` null starts at `next`.
 */
export function smoothLook(prev: Look | null, next: Look, k: number): Look {
  if (!prev) return next;
  return {
    heading: wrapAngle(prev.heading + wrapAngle(next.heading - prev.heading) * k),
    pitch: prev.pitch + (next.pitch - prev.pitch) * k,
  };
}

/**
 * The viewer's yaw for a heading, given the offset fixed when the control went
 * on (viewer yaw minus heading then). The viewer's yaw also grows turning right.
 */
export const yawFor = (look: Look, offset: number): number => wrapAngle(offset + look.heading);

/** The screen's rotation in degrees, 0 where the browser can't say. */
export function screenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation) return screen.orientation.angle;
  const legacy = (globalThis as { orientation?: unknown }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

/*
 * Camera and frustum math. The conventions are three.js's: column-major
 * matrices, -z forward and +y up, NDC in [-1, 1] on every axis.
 */

import type { Vec3 } from '../project.js';
import type { View } from '../types.js';

/** 4×4 matrix, column-major. */
export type Mat4 = Float32Array;
export interface Sphere {
  cx: number;
  cy: number;
  cz: number;
  r: number;
}
/** 6 planes × [a,b,c,d], each normalized so a²+b²+c²=1. */
export type Frustum = Float32Array;

const NEAR = 0.1;
const FAR = 100;

const DEG2RAD = Math.PI / 180;

/** The largest vertical fov whose horizontal fov stays within maxHorizontalFovDeg. */
export function maxVFovDeg(maxHorizontalFovDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((maxHorizontalFovDeg * Math.PI) / 360) / aspect) * 180) / Math.PI;
}

/** Cap the vertical fov so the horizontal fov never exceeds maxHorizontalFovDeg. */
export function effectiveVFovDeg(
  requestedDeg: number,
  maxHorizontalFovDeg: number,
  aspect: number,
): number {
  return Math.min(requestedDeg, maxVFovDeg(maxHorizontalFovDeg, aspect));
}

/**
 * Write the camera basis for (yaw, pitch) into `b` as
 * [xx, xz, yx, yy, yz, zx, zy, zz] (x.y is always 0): -z is forward, up
 * is +y.
 *
 * The right vector is (cos yaw, 0, sin yaw). It is unit length and depends
 * on yaw alone, so it has no degenerate case at the poles and does not flip
 * when pitch passes ±π/2.
 */
function cameraBasis(yaw: number, pitch: number, b: Float64Array): void {
  // z = -dirInto(yaw, pitch), written out to skip the object.
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const zx = -sy * cp;
  const zy = -Math.sin(pitch);
  const zz = cy * cp;
  const xx = cy;
  const xz = sy;
  // y = cross(z, x), with x.y == 0
  b[0] = xx;
  b[1] = xz;
  b[2] = zy * xz;
  b[3] = zz * xx - zx * xz;
  b[4] = -zy * xx;
  b[5] = zx;
  b[6] = zy;
  b[7] = zz;
}

const basis = new Float64Array(8);

/**
 * Projection · view, column-major. Writes into `out` when given, so a caller
 * can reuse one matrix every frame.
 *
 * P is sparse (f/aspect, f, A, B and -1), so the product is written out
 * directly: row 0 is (f/aspect)·x, row 1 is f·y, row 2 is A·z plus B in the
 * translation column, and row 3 is -z.
 */
export function viewProjection(
  view: View,
  aspect: number,
  maxHorizontalFovDeg: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const vfov = effectiveVFovDeg(view.fov, maxHorizontalFovDeg, aspect);
  const f = 1 / Math.tan((vfov * DEG2RAD) / 2);
  const fa = f / aspect;
  const nf = 1 / (NEAR - FAR);
  const a = (FAR + NEAR) * nf;
  const b = 2 * FAR * NEAR * nf;
  cameraBasis(view.yaw, view.pitch, basis);
  const xx = basis[0]!;
  const xz = basis[1]!;
  const yx = basis[2]!;
  const yy = basis[3]!;
  const yz = basis[4]!;
  const zx = basis[5]!;
  const zy = basis[6]!;
  const zz = basis[7]!;
  out[0] = fa * xx;
  out[1] = f * yx;
  out[2] = a * zx;
  out[3] = -zx;
  out[4] = 0;
  out[5] = f * yy;
  out[6] = a * zy;
  out[7] = -zy;
  out[8] = fa * xz;
  out[9] = f * yz;
  out[10] = a * zz;
  out[11] = -zz;
  out[12] = 0;
  out[13] = 0;
  out[14] = b;
  out[15] = 0;
  return out;
}

/** Whether two matrices are equal, element by element. */
export function sameMatrix(a: Mat4, b: Mat4): boolean {
  for (let k = 0; k < 16; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Direction → NDC, written into `out`, which may be `dir` itself. */
export function projectDirInto(out: Vec3, dir: Vec3, viewProj: Mat4): Vec3 {
  const m = viewProj;
  const { x, y, z } = dir;
  const iw = 1 / (m[3]! * x + m[7]! * y + m[11]! * z + m[15]!);
  out.x = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw;
  out.y = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw;
  out.z = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw;
  return out;
}

/**
 * NDC → normalized ray direction from the camera at the origin.
 *
 * For M = P·V from {@link viewProjection}, rows 0, 1 and 3 of M are
 * (f/aspect)·x, f·y and the forward vector. So the ray through (ndcX, ndcY)
 * is ndcX·r0/|r0|² + ndcY·r1/|r1|² + r3, with no general 4×4 inverse.
 */
export function unprojectNDC(ndcX: number, ndcY: number, viewProj: Mat4): Vec3 {
  const m = viewProj;
  const r0x = m[0]!;
  const r0y = m[4]!;
  const r0z = m[8]!;
  const r1x = m[1]!;
  const r1y = m[5]!;
  const r1z = m[9]!;
  const s0 = ndcX / (r0x * r0x + r0y * r0y + r0z * r0z);
  const s1 = ndcY / (r1x * r1x + r1y * r1y + r1z * r1z);
  const x = s0 * r0x + s1 * r1x + m[3]!;
  const y = s0 * r0y + s1 * r1y + m[7]!;
  const z = s0 * r0z + s1 * r1z + m[11]!;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * Extract the 6 frustum planes from a view-projection matrix and normalize
 * them (the Gribb-Hartmann method). Plane order:
 * right, left, bottom, top, far, near.
 */
export function frustumFromViewProj(viewProj: Mat4, out: Frustum = new Float32Array(24)): Frustum {
  const m = viewProj;
  const m0 = m[0]!;
  const m1 = m[1]!;
  const m2 = m[2]!;
  const m3 = m[3]!;
  const m4 = m[4]!;
  const m5 = m[5]!;
  const m6 = m[6]!;
  const m7 = m[7]!;
  const m8 = m[8]!;
  const m9 = m[9]!;
  const m10 = m[10]!;
  const m11 = m[11]!;
  const m12 = m[12]!;
  const m13 = m[13]!;
  const m14 = m[14]!;
  const m15 = m[15]!;
  setPlane(out, 0, m3 - m0, m7 - m4, m11 - m8, m15 - m12); // right
  setPlane(out, 1, m3 + m0, m7 + m4, m11 + m8, m15 + m12); // left
  setPlane(out, 2, m3 + m1, m7 + m5, m11 + m9, m15 + m13); // bottom
  setPlane(out, 3, m3 - m1, m7 - m5, m11 - m9, m15 - m13); // top
  setPlane(out, 4, m3 - m2, m7 - m6, m11 - m10, m15 - m14); // far
  setPlane(out, 5, m3 + m2, m7 + m6, m11 + m10, m15 + m14); // near
  return out;
}

function setPlane(out: Frustum, i: number, a: number, b: number, c: number, d: number): void {
  const inv = 1 / Math.hypot(a, b, c);
  out[i * 4] = a * inv;
  out[i * 4 + 1] = b * inv;
  out[i * 4 + 2] = c * inv;
  out[i * 4 + 3] = d * inv;
}

/** Whether `sphere` is at least partly inside every plane of `frustum`. */
export function intersectsSphere(frustum: Frustum, sphere: Sphere): boolean {
  const negR = -sphere.r;
  for (let i = 0; i < 6; i++) {
    const d =
      frustum[i * 4]! * sphere.cx +
      frustum[i * 4 + 1]! * sphere.cy +
      frustum[i * 4 + 2]! * sphere.cz +
      frustum[i * 4 + 3]!;
    if (d < negR) return false;
  }
  return true;
}

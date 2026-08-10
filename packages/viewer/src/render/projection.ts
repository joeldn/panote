import { dirFromYawPitch } from '../project.js';
import type { Vec3 } from '../project.js';
import type { View } from '../types.js';

/** 4×4 matrix, column-major (same element layout as three's Matrix4.elements). */
export type Mat4 = Float32Array;
// Vec3 is re-exported so existing importers of it from projection.js keep working.
export type { Vec3 };
export type Sphere = { cx: number; cy: number; cz: number; r: number };
/** 6 planes × [a,b,c,d], each normalized so a²+b²+c²=1. */
export type Frustum = Float32Array;

export const NEAR = 0.1;
export const FAR = 100;

const DEG2RAD = Math.PI / 180;

/**
 * Cap the vertical fov so the horizontal fov never exceeds maxHorizontalFovDeg.
 * Unifies the duplicated helper from the former scene.ts and PanoViewer.
 */
export function effectiveVFovDeg(
  requestedDeg: number,
  maxHorizontalFovDeg: number,
  aspect: number,
): number {
  const maxVFov =
    (2 * Math.atan(Math.tan((maxHorizontalFovDeg * Math.PI) / 360) / aspect) * 180) / Math.PI;
  return Math.min(requestedDeg, maxVFov);
}

/** Perspective projection, column-major, identical to three's makePerspective. */
export function perspective(vfovDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((vfovDeg * DEG2RAD) / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

/**
 * View matrix for a camera at the origin looking along dirFromYawPitch(yaw,pitch),
 * up = +y. Column-major. Equivalent to three's lookAt(target)+matrixWorldInverse
 * when the camera is at the origin.
 */
export function viewMatrix(yaw: number, pitch: number): Mat4 {
  const fwd = dirFromYawPitch(yaw, pitch); // points toward the target
  // three's lookAt builds a basis with -z = forward.
  const zx = -fwd.x,
    zy = -fwd.y,
    zz = -fwd.z; // camera +z (away from target)
  // x = normalize(cross(up, z)) with up = (0,1,0); cross((0,1,0), z) = (z_z, 0, -z_x)
  // The y-component is always 0 by construction, so it is kept as a literal
  // below rather than carried through as a variable.
  let xx = zz;
  let xz = -zx;
  const xl = Math.hypot(xx, xz) || 1; // degeneracy guard: fwd parallel to up (straight up/down)
  xx /= xl;
  xz /= xl;
  // y = cross(z, x), with x.y == 0
  const yx = zy * xz;
  const yy = zz * xx - zx * xz;
  const yz = -zy * xx;
  // View matrix = inverse of the camera world matrix (rotation transposed,
  // translation zero because the camera is at the origin). Column-major.
  const m = new Float32Array(16);
  m[0] = xx;
  m[4] = 0;
  m[8] = xz;
  m[12] = 0;
  m[1] = yx;
  m[5] = yy;
  m[9] = yz;
  m[13] = 0;
  m[2] = zx;
  m[6] = zy;
  m[10] = zz;
  m[14] = 0;
  m[3] = 0;
  m[7] = 0;
  m[11] = 0;
  m[15] = 1;
  return m;
}

/** Column-major multiply: out = a · b (a on the left, as in three's premultiply). */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r]! * b[c * 4 + 0]! +
        a[1 * 4 + r]! * b[c * 4 + 1]! +
        a[2 * 4 + r]! * b[c * 4 + 2]! +
        a[3 * 4 + r]! * b[c * 4 + 3]!;
    }
  }
  return o;
}

export function viewProjection(view: View, aspect: number, maxHorizontalFovDeg: number): Mat4 {
  const vfov = effectiveVFovDeg(view.fov, maxHorizontalFovDeg, aspect);
  const proj = perspective(vfov, aspect, NEAR, FAR);
  const vm = viewMatrix(view.yaw, view.pitch);
  return multiply(proj, vm);
}

/** Transform a point/direction by a column-major matrix, returning w too. */
function transform(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number; w: number } {
  return {
    x: m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    y: m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    z: m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    w: m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  };
}

/** Direction → NDC. Matches three's Vector3.project(camera). */
export function projectDir(dir: Vec3, viewProj: Mat4): Vec3 {
  const t = transform(viewProj, dir.x, dir.y, dir.z);
  const iw = 1 / t.w;
  return { x: t.x * iw, y: t.y * iw, z: t.z * iw };
}

function invert(m: Mat4): Mat4 {
  // Standard 4×4 inverse (column-major). Adapted from three's Matrix4.invert.
  const n11 = m[0]!,
    n21 = m[1]!,
    n31 = m[2]!,
    n41 = m[3]!;
  const n12 = m[4]!,
    n22 = m[5]!,
    n32 = m[6]!,
    n42 = m[7]!;
  const n13 = m[8]!,
    n23 = m[9]!,
    n33 = m[10]!,
    n43 = m[11]!;
  const n14 = m[12]!,
    n24 = m[13]!,
    n34 = m[14]!,
    n44 = m[15]!;
  const t11 =
    n23 * n34 * n42 -
    n24 * n33 * n42 +
    n24 * n32 * n43 -
    n22 * n34 * n43 -
    n23 * n32 * n44 +
    n22 * n33 * n44;
  const t12 =
    n14 * n33 * n42 -
    n13 * n34 * n42 -
    n14 * n32 * n43 +
    n12 * n34 * n43 +
    n13 * n32 * n44 -
    n12 * n33 * n44;
  const t13 =
    n13 * n24 * n42 -
    n14 * n23 * n42 +
    n14 * n22 * n43 -
    n12 * n24 * n43 -
    n13 * n22 * n44 +
    n12 * n23 * n44;
  const t14 =
    n14 * n23 * n32 -
    n13 * n24 * n32 -
    n14 * n22 * n33 +
    n12 * n24 * n33 +
    n13 * n22 * n34 -
    n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  const idet = 1 / det;
  const o = new Float32Array(16);
  o[0] = t11 * idet;
  o[1] =
    (n24 * n33 * n41 -
      n23 * n34 * n41 -
      n24 * n31 * n43 +
      n21 * n34 * n43 +
      n23 * n31 * n44 -
      n21 * n33 * n44) *
    idet;
  o[2] =
    (n22 * n34 * n41 -
      n24 * n32 * n41 +
      n24 * n31 * n42 -
      n21 * n34 * n42 -
      n22 * n31 * n44 +
      n21 * n32 * n44) *
    idet;
  o[3] =
    (n23 * n32 * n41 -
      n22 * n33 * n41 -
      n23 * n31 * n42 +
      n21 * n33 * n42 +
      n22 * n31 * n43 -
      n21 * n32 * n43) *
    idet;
  o[4] = t12 * idet;
  o[5] =
    (n13 * n34 * n41 -
      n14 * n33 * n41 +
      n14 * n31 * n43 -
      n11 * n34 * n43 -
      n13 * n31 * n44 +
      n11 * n33 * n44) *
    idet;
  o[6] =
    (n14 * n32 * n41 -
      n12 * n34 * n41 -
      n14 * n31 * n42 +
      n11 * n34 * n42 +
      n12 * n31 * n44 -
      n11 * n32 * n44) *
    idet;
  o[7] =
    (n12 * n33 * n41 -
      n13 * n32 * n41 +
      n13 * n31 * n42 -
      n11 * n33 * n42 -
      n12 * n31 * n43 +
      n11 * n32 * n43) *
    idet;
  o[8] = t13 * idet;
  o[9] =
    (n14 * n23 * n41 -
      n13 * n24 * n41 -
      n14 * n21 * n43 +
      n11 * n24 * n43 +
      n13 * n21 * n44 -
      n11 * n23 * n44) *
    idet;
  o[10] =
    (n12 * n24 * n41 -
      n14 * n22 * n41 +
      n14 * n21 * n42 -
      n11 * n24 * n42 -
      n12 * n21 * n44 +
      n11 * n22 * n44) *
    idet;
  o[11] =
    (n13 * n22 * n41 -
      n12 * n23 * n41 -
      n13 * n21 * n42 +
      n11 * n23 * n42 +
      n12 * n21 * n43 -
      n11 * n22 * n43) *
    idet;
  o[12] = t14 * idet;
  o[13] =
    (n13 * n24 * n31 -
      n14 * n23 * n31 +
      n14 * n21 * n33 -
      n11 * n24 * n33 -
      n13 * n21 * n34 +
      n11 * n23 * n34) *
    idet;
  o[14] =
    (n14 * n22 * n31 -
      n12 * n24 * n31 -
      n14 * n21 * n32 +
      n11 * n24 * n32 +
      n12 * n21 * n34 -
      n11 * n22 * n34) *
    idet;
  o[15] =
    (n12 * n23 * n31 -
      n13 * n22 * n31 +
      n13 * n21 * n32 -
      n11 * n23 * n32 -
      n12 * n21 * n33 +
      n11 * n22 * n33) *
    idet;
  return o;
}

/**
 * NDC (with z=0.5) → normalized ray direction from the origin. Matches
 * three's Vector3.unproject(camera) followed by sub(cameraPosition).normalize()
 * when the camera is at the origin.
 */
export function unprojectNDC(ndcX: number, ndcY: number, viewProj: Mat4): Vec3 {
  const inv = invert(viewProj);
  const t = transform(inv, ndcX, ndcY, 0.5);
  const iw = 1 / t.w;
  const x = t.x * iw;
  const y = t.y * iw;
  const z = t.z * iw;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * Extract the 6 frustum planes from a view-projection matrix and normalize
 * them, matching three's Frustum.setFromProjectionMatrix. Plane order:
 * right, left, bottom, top, far, near.
 */
export function frustumFromViewProj(viewProj: Mat4): Frustum {
  const m = viewProj;
  const m0 = m[0]!,
    m1 = m[1]!,
    m2 = m[2]!,
    m3 = m[3]!;
  const m4 = m[4]!,
    m5 = m[5]!,
    m6 = m[6]!,
    m7 = m[7]!;
  const m8 = m[8]!,
    m9 = m[9]!,
    m10 = m[10]!,
    m11 = m[11]!;
  const m12 = m[12]!,
    m13 = m[13]!,
    m14 = m[14]!,
    m15 = m[15]!;
  const planes = new Float32Array(24);
  const set = (i: number, a: number, b: number, c: number, d: number) => {
    const inv = 1 / Math.hypot(a, b, c);
    planes[i * 4] = a * inv;
    planes[i * 4 + 1] = b * inv;
    planes[i * 4 + 2] = c * inv;
    planes[i * 4 + 3] = d * inv;
  };
  set(0, m3 - m0, m7 - m4, m11 - m8, m15 - m12); // right
  set(1, m3 + m0, m7 + m4, m11 + m8, m15 + m12); // left
  set(2, m3 + m1, m7 + m5, m11 + m9, m15 + m13); // bottom
  set(3, m3 - m1, m7 - m5, m11 - m9, m15 - m13); // top
  set(4, m3 - m2, m7 - m6, m11 - m10, m15 - m14); // far
  set(5, m3 + m2, m7 + m6, m11 + m10, m15 + m14); // near
  return planes;
}

/** Plane-vs-sphere test, matching three's Frustum.intersectsSphere. */
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

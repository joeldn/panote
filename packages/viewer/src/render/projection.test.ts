import { describe, it, expect } from 'vitest';
import {
  NEAR,
  FAR,
  effectiveVFovDeg,
  viewProjection,
  projectDir,
  unprojectNDC,
  frustumFromViewProj,
  intersectsSphere,
} from './projection.js';
import { dirFromYawPitch } from '../project.js';

// Reference values captured from three@0.171.0 (see plan Task 1 Step 1).
const VIEW_A = { yaw: 0.3, pitch: 0.1, fov: 60 };
const ASPECT_A = 16 / 9;
const MAXH = 100; // maxHorizontalFov, uncapped here (60 < cap 67.67)
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('effectiveVFovDeg', () => {
  it('caps horizontal fov, matching three lookAt math', () => {
    near(effectiveVFovDeg(80, 100, 16 / 9), 67.6727479708);
    near(effectiveVFovDeg(80, 100, 1), 80); // 80 < cap 100 → uncapped
    near(effectiveVFovDeg(120, 100, 1), 100);
    near(effectiveVFovDeg(90, 100, 4 / 3), 83.5816570306);
  });
});

describe('viewProjection', () => {
  it('matches the three.js projection·view matrix element-for-element', () => {
    const m = viewProjection(VIEW_A, ASPECT_A, MAXH);
    const expected = [
      0.9307638773, -0.0511003346, 0.2946325129, 0.2940438366, 0, 1.723397768, 0.1000332833,
      0.0998334166, 0.2879190071, 0.1651934897, -0.9524668165, -0.9505637859, 0, 0, -0.2002002002,
      0,
    ];
    for (let i = 0; i < 16; i++) near(m[i]!, expected[i]!);
  });
});

describe('projectDir', () => {
  const vp = viewProjection(VIEW_A, ASPECT_A, MAXH);
  it('projects the view-centre direction to NDC origin', () => {
    const p = projectDir(dirFromYawPitch(0.3, 0.1), vp);
    near(p.x, 0);
    near(p.y, 0);
    near(p.z, 0.8018018018);
  });
  it('projects an off-centre direction to the three reference NDC', () => {
    const p = projectDir(dirFromYawPitch(0.5, 0.2), vp);
    near(p.x, 0.1944522833);
    near(p.y, 0.1807101916);
    near(p.z, 0.7967875263);
  });
});

describe('unprojectNDC', () => {
  it('unprojects an NDC point to the three reference ray direction', () => {
    const vp = viewProjection(VIEW_A, ASPECT_A, MAXH);
    const d = unprojectNDC(0.4, -0.3, vp);
    near(d.x, 0.6315170768);
    near(d.y, -0.0662287066);
    near(d.z, -0.7725282779);
  });
});

describe('frustumFromViewProj + intersectsSphere', () => {
  const vp = viewProjection(VIEW_A, ASPECT_A, MAXH);
  const f = frustumFromViewProj(vp);
  const fwd = dirFromYawPitch(0.3, 0.1); // camera forward
  it('accepts a sphere in front of the camera', () => {
    expect(
      intersectsSphere(f, {
        cx: fwd.x * 10,
        cy: fwd.y * 10,
        cz: fwd.z * 10,
        r: 1,
      }),
    ).toBe(true);
  });
  it('rejects a sphere behind the camera', () => {
    expect(
      intersectsSphere(f, {
        cx: -fwd.x * 10,
        cy: -fwd.y * 10,
        cz: -fwd.z * 10,
        r: 1,
      }),
    ).toBe(false);
  });
  it('rejects a sphere far to the side', () => {
    const sx = -fwd.z,
      sz = fwd.x;
    const len = Math.hypot(sx, sz);
    expect(
      intersectsSphere(f, {
        cx: (sx / len) * 10,
        cy: 0,
        cz: (sz / len) * 10,
        r: 0.5,
      }),
    ).toBe(false);
  });
});

describe('constants', () => {
  it('keeps three near/far', () => {
    expect(NEAR).toBe(0.1);
    expect(FAR).toBe(100);
  });
});

// Property-based checks (three.js is removed — no golden values).
const allFinite = (m: Float32Array): boolean => Array.from(m).every((v) => Number.isFinite(v));

describe('pole stability', () => {
  const poles = [Math.PI / 2 - 1e-3, -(Math.PI / 2 - 1e-3)];
  const yaws = [0, 0.7, -1.2, 2.5];
  for (const pitch of poles) {
    for (const yaw of yaws) {
      it(`finite matrix + centred projection near pole (yaw=${yaw}, pitch=${pitch.toFixed(4)})`, () => {
        const vp = viewProjection({ yaw, pitch, fov: 70 }, 16 / 9, MAXH);
        expect(allFinite(vp)).toBe(true);
        const p = projectDir(dirFromYawPitch(yaw, pitch), vp);
        near(p.x, 0);
        near(p.y, 0);
      });
    }
  }
});

describe('project/unproject round-trip', () => {
  const views = [
    { yaw: 0.3, pitch: 0.1, fov: 60 },
    { yaw: -1.1, pitch: -0.4, fov: 90 },
    { yaw: 2.0, pitch: 0.6, fov: 200 }, // fov above cap → capped internally
    { yaw: 0, pitch: 0, fov: 45 },
  ];
  for (const v of views) {
    it(`recovers direction for yaw=${v.yaw}, pitch=${v.pitch}, fov=${v.fov}`, () => {
      const vp = viewProjection(v, 16 / 9, MAXH);
      const d = dirFromYawPitch(v.yaw, v.pitch);
      const p = projectDir(d, vp);
      const r = unprojectNDC(p.x, p.y, vp);
      // d is already unit length; unprojectNDC returns a normalized ray.
      expect(r.x).toBeCloseTo(d.x, 6);
      expect(r.y).toBeCloseTo(d.y, 6);
      expect(r.z).toBeCloseTo(d.z, 6);
    });
  }
});

describe('fov cap consistency', () => {
  it('a far-above-cap fov produces the same matrix as the exact effective fov', () => {
    const aspect = 16 / 9;
    const maxH = 100;
    const eff = effectiveVFovDeg(500, maxH, aspect);
    const capped = viewProjection({ yaw: 0.4, pitch: 0.2, fov: 500 }, aspect, maxH);
    const atEff = viewProjection({ yaw: 0.4, pitch: 0.2, fov: eff }, aspect, maxH);
    for (let i = 0; i < 16; i++) expect(capped[i]!).toBe(atEff[i]!);
  });
});

describe('unprojectNDC at corners', () => {
  it('returns finite values at all four NDC corners', () => {
    const vp = viewProjection({ yaw: 0.3, pitch: 0.1, fov: 60 }, 16 / 9, MAXH);
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const d = unprojectNDC(nx, ny, vp);
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
      expect(Number.isFinite(d.z)).toBe(true);
    }
  });
});

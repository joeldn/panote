import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FACES, faceUVToDir, FRONT_FACE, type Face, type Vec3 } from '@panote/core';
import {
  cubeSampler,
  equirectSampler,
  facesInView,
  OG_HEIGHT,
  OG_VIEW,
  OG_WIDTH,
  ogFaceSize,
  ogImage,
  renderView,
  type View,
} from './og.js';
import type { RgbImage } from './remap.js';

type Rgb = [number, number, number];

// One flat, far-apart colour per face, so a JPEG round trip can't blur one into another.
const FACE_COLOURS: Record<Face, Rgb> = {
  px: [220, 30, 30],
  nx: [30, 200, 30],
  py: [30, 30, 220],
  ny: [220, 220, 30],
  pz: [220, 30, 220],
  nz: [30, 220, 220],
};

const majorFace = (d: Vec3): Face => {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return d.x > 0 ? 'px' : 'nx';
  if (ay >= az) return d.y > 0 ? 'py' : 'ny';
  return d.z > 0 ? 'pz' : 'nz';
};

const solid = (size: number, [r, g, b]: Rgb): RgbImage => {
  const data = Buffer.alloc(size * size * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return { data, width: size, height: size, channels: 3 };
};

const labelledCube = (size = 16): Record<Face, RgbImage> =>
  Object.fromEntries(FACES.map((f) => [f, solid(size, FACE_COLOURS[f])])) as Record<Face, RgbImage>;

/**
 * An equirect whose every pixel is coloured by the cube face its direction falls on,
 * worked out from the viewer's own yaw/pitch convention (u = yaw/2π + 0.5, yaw 0 = -z,
 * yaw +π/2 = +x), independently of the code under test.
 */
const labelledEquirect = (w = 256, h = 128): RgbImage => {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const pitch = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const yaw = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const d = {
        x: Math.sin(yaw) * Math.cos(pitch),
        y: Math.sin(pitch),
        z: -Math.cos(yaw) * Math.cos(pitch),
      };
      const [r, g, b] = FACE_COLOURS[majorFace(d)];
      const i = (y * w + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { data, width: w, height: h, channels: 3 };
};

const pixel = (buf: Uint8Array, width: number, x: number, y: number): Rgb => {
  const i = (y * width + x) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
};

const faceOf = (rgb: Rgb, tolerance = 40): Face | undefined =>
  FACES.find((f) => FACE_COLOURS[f].every((c, i) => Math.abs(c - rgb[i]!) <= tolerance));

const W = 120;
const H = 63;
const centre = (buf: Uint8Array) => pixel(buf, W, W / 2, Math.floor(H / 2));
const leftMid = (buf: Uint8Array) => pixel(buf, W, 0, Math.floor(H / 2));
const rightMid = (buf: Uint8Array) => pixel(buf, W, W - 1, Math.floor(H / 2));
const topMid = (buf: Uint8Array) => pixel(buf, W, W / 2, 0);
const bottomMid = (buf: Uint8Array) => pixel(buf, W, W / 2, H - 1);

const view = (v: Partial<View>): View => ({ ...OG_VIEW, ...v });

describe.each([
  ['cube', () => cubeSampler(labelledCube())],
  ['equirect', () => equirectSampler(labelledEquirect())],
])('renderView over a labelled %s', (_name, makeSampler) => {
  const sampler = makeSampler();
  const render = (v: Partial<View>) => renderView(sampler, W, H, view(v));

  it('shows nz in the centre at yaw 0, with px on the right and nx on the left', () => {
    const img = render({});
    expect(img.length).toBe(W * H * 3);
    expect(faceOf(centre(img))).toBe('nz');
    expect(faceOf(rightMid(img))).toBe('px');
    expect(faceOf(leftMid(img))).toBe('nx');
  });

  it.each([
    [Math.PI / 2, 'px'],
    [Math.PI, 'pz'],
    [-Math.PI / 2, 'nx'],
  ] as const)('turns to yaw %f and finds %s in the centre', (yaw, face) => {
    expect(faceOf(centre(render({ yaw })))).toBe(face);
  });

  it('pitches up into py at the top and down into ny at the bottom', () => {
    const up = render({ pitch: 0.9 });
    expect(faceOf(topMid(up))).toBe('py');
    expect(faceOf(bottomMid(up))).toBe('nz');
    const down = render({ pitch: -0.9 });
    expect(faceOf(bottomMid(down))).toBe('ny');
    expect(faceOf(topMid(down))).toBe('nz');
  });
});

/**
 * The viewer's camera basis, copied from cameraBasis in
 * packages/viewer/src/render/projection.ts (the tiler can't import the viewer). Its
 * camera z is -forward, x is right and y = z × x is up. If the viewer's basis changes,
 * og.jpg stops matching the first frame it shows, and this copy has to change with it.
 */
function viewerBasis(yaw: number, pitch: number): { right: Vec3; up: Vec3; forward: Vec3 } {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const zx = -sy * cp;
  const zy = -Math.sin(pitch);
  const zz = cy * cp;
  const xx = cy;
  const xz = sy;
  return {
    right: { x: xx, y: 0, z: xz },
    up: { x: zy * xz, y: zz * xx - zx * xz, z: -zy * xx },
    forward: { x: -zx, y: -zy, z: -zz },
  };
}

describe("renderView's camera basis", () => {
  it.each([
    [0, 0],
    [0.7, 0.3],
    [-2.2, -0.8],
    [Math.PI, 1.2],
  ])("matches the viewer's at yaw %f, pitch %f", (yaw, pitch) => {
    // A 3x3 render: the middle pixel's ray is the forward vector, and the pixels to its
    // right and above step along the right and up vectors by 2/3 of the half-extent.
    const hfovDeg = 90;
    const rays: Vec3[] = [];
    renderView(
      (d, out) => {
        rays.push({ ...d });
        out.fill(0);
      },
      3,
      3,
      { yaw, pitch, hfovDeg },
    );
    const tx = Math.tan((hfovDeg * Math.PI) / 360);
    const ray = (x: number, y: number) => rays[y * 3 + x]!;
    const { right, up, forward } = viewerBasis(yaw, pitch);
    const close = (a: Vec3, b: Vec3) => {
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.y).toBeCloseTo(b.y, 9);
      expect(a.z).toBeCloseTo(b.z, 9);
    };
    const step = (v: Vec3, k: number): Vec3 => ({
      x: forward.x + k * v.x,
      y: forward.y + k * v.y,
      z: forward.z + k * v.z,
    });
    close(ray(1, 1), forward);
    close(ray(2, 1), step(right, (2 / 3) * tx));
    close(ray(1, 0), step(up, (2 / 3) * tx));
    close(ray(0, 2), {
      x: forward.x - (2 / 3) * tx * (right.x + up.x),
      y: forward.y - (2 / 3) * tx * (right.y + up.y),
      z: forward.z - (2 / 3) * tx * (right.z + up.z),
    });
  });
});

describe('equirectSampler', () => {
  it('wraps across the ±180° seam instead of clamping', () => {
    // A source whose left and right columns differ: looking straight back (yaw π)
    // samples the seam and must blend both edge columns, not just one of them.
    const w = 8;
    const h = 4;
    const data = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      data[(y * w + 0) * 3] = 200;
      data[(y * w + (w - 1)) * 3] = 0;
    }
    const out: Rgb = [0, 0, 0];
    equirectSampler({ data, width: w, height: h, channels: 3 })({ x: 0, y: 0, z: 1 }, out);
    expect(out[0]).toBeCloseTo(100, 0);
  });
});

describe('cubeSampler', () => {
  it('reads the face pixel faceUVToDir names, so tiles and the preview agree', () => {
    // A 4x4 nz face with one marked pixel; its direction must read it back.
    const faces = labelledCube(4);
    const marked = faces.nz.data as Buffer;
    marked.fill(0);
    const i = (1 * 4 + 3) * 3; // (x=3, y=1)
    marked[i] = 255;
    const out: Rgb = [0, 0, 0];
    cubeSampler(faces)(faceUVToDir('nz', 3.5 / 4, 1.5 / 4), out);
    expect(out[0]).toBeCloseTo(255, 5);
  });

  it('names a face that is in view but was not loaded', () => {
    const { nz } = labelledCube(4);
    expect(() => cubeSampler({ nz })({ x: 1, y: 0, z: 0 }, [0, 0, 0])).toThrow(/face px/);
  });
});

// A few million rays or a full-size encode each: quick normally, slow under coverage.
describe('facesInView', () => {
  it('needs only the front face (nz), px and nx for the default view', () => {
    expect(FRONT_FACE).toBe('nz');
    expect(facesInView(OG_VIEW)).toEqual(['px', 'nx', FRONT_FACE]);
  }, 20_000);

  it('adds py when the view tilts up far enough to see it', () => {
    const faces = facesInView(view({ pitch: 0.9 }));
    expect(faces).toContain('py');
    expect(faces).not.toContain('ny');
  }, 20_000);
});

describe('ogFaceSize', () => {
  it('asks for a face at least as sharp as the supersampled render at the centre', () => {
    // 2x supersample of 1200px over a 100° hfov: 2400 / (2·tan 50°) px per unit tangent,
    // and a face spans 2 units of tangent.
    const need = (2 * OG_WIDTH) / Math.tan((50 * Math.PI) / 180);
    expect(ogFaceSize(OG_VIEW)).toBe(Math.ceil(need));
  });
});

describe('ogImage', () => {
  it('encodes a 1200x630 JPEG of the default view, nz in the centre', async () => {
    // Without the supersample (a quarter of the rays): the filtering is the next test's job.
    const jpeg = await ogImage(equirectSampler(labelledEquirect(1024, 512)), OG_VIEW, 1).toBuffer();
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(OG_WIDTH);
    expect(meta.height).toBe(OG_HEIGHT);
    expect([OG_WIDTH, OG_HEIGHT]).toEqual([1200, 630]);
    const { data } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const c = pixel(data, OG_WIDTH, OG_WIDTH / 2, OG_HEIGHT / 2);
    expect(faceOf(c)).toBe('nz');
    expect(faceOf(pixel(data, OG_WIDTH, OG_WIDTH - 2, OG_HEIGHT / 2))).toBe('px');
  }, 20_000);

  it('area-filters fine detail to grey rather than aliasing it into moiré', async () => {
    // 1px vertical stripes, a bit finer than the output's pixel pitch at the centre.
    const w = 4096;
    const h = 2048;
    // Every row is the same, so build one and copy it down.
    const row = Buffer.alloc(w * 3);
    for (let x = 1; x < w; x += 2) row.fill(255, x * 3, x * 3 + 3);
    const data = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) row.copy(data, y * w * 3);
    const jpeg = await ogImage(equirectSampler({ data, width: w, height: h, channels: 3 }))
      .png()
      .toBuffer();
    const meta = await sharp(jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([OG_WIDTH, OG_HEIGHT]);
    const { data: out } = await sharp(jpeg)
      .extract({ left: 500, top: 280, width: 200, height: 70 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const values = [...out];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    expect(mean).toBeGreaterThan(100);
    expect(mean).toBeLessThan(155);
    expect(sd).toBeLessThan(20);
  }, 20_000);
});

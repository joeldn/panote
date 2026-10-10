/**
 * Writes the example's test cube: 6 faces × levels 0 and 1 of 256 px PNG
 * tiles, into public/cube/<level>/<face>/<x>-<y>.png.
 *
 * Every texel is drawn from the direction the viewer shows it at, through
 * the viewer's own faceUVToDir, so the labels read upright and unmirrored on
 * screen and the files show the face convention a source must follow. Each
 * face carries its id and the way you look to see it; each tile, its level
 * and x-y.
 *
 *   node packages/viewer/examples/vanilla/make-cube.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { FACES, faceUVToDir, type Face } from '../../src/cube.ts';

const TILE = 256;
const MAX_LEVEL = 1;
const OUT = join(import.meta.dirname, 'public', 'cube');

type V3 = [number, number, number];

// The camera's right and up when it looks at each face's centre: yaw 0
// looks at -z with +x to the right, yaw grows to the right, and looking
// straight up from yaw 0 puts +z at the top of the screen.
const BASIS: Record<Face, { right: V3; up: V3; name: string; colour: V3 }> = {
  nz: { right: [1, 0, 0], up: [0, 1, 0], name: 'AHEAD', colour: [52, 101, 164] },
  px: { right: [0, 0, 1], up: [0, 1, 0], name: 'RIGHT', colour: [78, 154, 6] },
  pz: { right: [-1, 0, 0], up: [0, 1, 0], name: 'BEHIND', colour: [204, 0, 0] },
  nx: { right: [0, 0, -1], up: [0, 1, 0], name: 'LEFT', colour: [196, 160, 0] },
  py: { right: [1, 0, 0], up: [0, 0, 1], name: 'UP', colour: [117, 80, 123] },
  ny: { right: [1, 0, 0], up: [0, 0, -1], name: 'DOWN', colour: [6, 152, 154] },
};

// 5 × 7 glyphs, one string per row, '#' set.
const FONT: Record<string, string[]> = {
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ####', '#    ', '#    ', '#  ##', '#   #', '#   #', ' ####'],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '#####'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '## ##', '#   #'],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
};

/**
 * Whether the text `lines` covers (x, y), with the block centred on (0, 0),
 * each glyph cell `cell` units on a side and +y up.
 */
function inText(lines: string[], cell: number, x: number, y: number): boolean {
  const rows = lines.length * 8 - 1;
  const row = Math.floor(((rows * cell) / 2 - y) / cell);
  const line = lines[Math.floor(row / 8)];
  const glyphRow = row % 8;
  if (row < 0 || !line || glyphRow === 7) return false;
  const cols = line.length * 6 - 1;
  const col = Math.floor(x / cell + cols / 2);
  if (col < 0 || col >= cols || col % 6 === 5) return false;
  return FONT[line[Math.floor(col / 6)]!]?.[glyphRow]?.[col % 6] === '#';
}

const dot = (a: V3, b: { x: number; y: number; z: number }) => a[0] * b.x + a[1] * b.y + a[2] * b.z;

/** RGB of the texel at (u, v) of `face`, a tile of `level` whose centre is at face uv (cu, cv). */
function texel(
  face: Face,
  level: number,
  label: string,
  u: number,
  v: number,
  cu: number,
  cv: number,
): V3 {
  const { right, up, name, colour } = BASIS[face];
  // Screen-space coordinates on the face, -1..1, +y up, as the viewer shows it.
  const d = faceUVToDir(face, u, v);
  const x = dot(right, d);
  const y = dot(up, d);
  const c = faceUVToDir(face, cu, cv);
  const tx = x - dot(right, c);
  const ty = y - dot(up, c);
  const ink: V3 = [255, 255, 255];
  if (inText([face.toUpperCase(), name], 0.028, x, y - 0.12)) return ink;
  if (inText([label], level === 0 ? 0.02 : 0.014, tx, ty + (level === 0 ? 0.55 : 0.28))) return ink;
  // A line every eighth of the face, and on its edges.
  const grid = (t: number) => Math.abs(t * 4 - Math.round(t * 4)) < 0.012 * 4;
  const shade = level === 0 ? 1 : 0.8;
  const k = grid(x) || grid(y) ? 0.55 * shade : shade;
  return [colour[0] * k, colour[1] * k, colour[2] * k];
}

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // no filter
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let bytes = 0;
for (let level = 0; level <= MAX_LEVEL; level++) {
  const n = 2 ** level;
  for (const face of FACES) {
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const rgb = new Uint8Array(TILE * TILE * 3);
        const label = `L${level} ${tx}-${ty}`;
        const cu = (tx + 0.5) / n;
        const cv = (ty + 0.5) / n;
        for (let py = 0; py < TILE; py++) {
          for (let px = 0; px < TILE; px++) {
            const u = (tx + (px + 0.5) / TILE) / n;
            const v = (ty + (py + 0.5) / TILE) / n;
            rgb.set(texel(face, level, label, u, v, cu, cv), (py * TILE + px) * 3);
          }
        }
        const file = join(OUT, String(level), face, `${tx}-${ty}.png`);
        mkdirSync(dirname(file), { recursive: true });
        const data = png(TILE, TILE, rgb);
        writeFileSync(file, data);
        bytes += data.length;
      }
    }
  }
}
process.stdout.write(
  `wrote ${FACES.length * 5} tiles, ${Math.round(bytes / 1024)} KB, to ${OUT}\n`,
);

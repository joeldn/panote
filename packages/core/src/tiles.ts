export type SubRect = { u0: number; v0: number; u1: number; v1: number };

export function tilesPerEdge(level: number): number {
  return 2 ** level;
}

export function tileSubRect(level: number, x: number, y: number): SubRect {
  const g = tilesPerEdge(level);
  return { u0: x / g, v0: y / g, u1: (x + 1) / g, v1: (y + 1) / g };
}

/** Four UV corners in top-left, top-right, bottom-left, bottom-right order. */
export function tileCornersUV(
  level: number,
  x: number,
  y: number,
): [
  { u: number; v: number },
  { u: number; v: number },
  { u: number; v: number },
  { u: number; v: number },
] {
  const r = tileSubRect(level, x, y);
  return [
    { u: r.u0, v: r.v0 },
    { u: r.u1, v: r.v0 },
    { u: r.u0, v: r.v1 },
    { u: r.u1, v: r.v1 },
  ];
}

import { describe, it, expect } from 'vitest';
import { tilesPerEdge } from './tiles.js';

describe('tilesPerEdge', () => {
  it('is 2^level', () => {
    expect(tilesPerEdge(0)).toBe(1);
    expect(tilesPerEdge(1)).toBe(2);
    expect(tilesPerEdge(4)).toBe(16);
  });
});

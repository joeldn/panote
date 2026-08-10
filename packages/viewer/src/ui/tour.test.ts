import { describe, it, expect } from 'vitest';
import { arrivalView } from './tour.js';

describe('arrivalView', () => {
  it('faces the direction walked (link heading)', () => {
    expect(arrivalView({ to: 'b', yaw: 1.2 })).toEqual({ yaw: 1.2 });
  });
});

import { describe, expect, it } from 'vitest';

import { redactAdminPath } from './error-path.js';

describe('redactAdminPath', () => {
  it.each([
    ['/app/t/tour_123', '/app/t/:tourId'],
    ['/app/t/tour_123/share/link', '/app/t/:tourId/share/link'],
    ['/app/t/tour_123/preview', '/app/t/:tourId/preview'],
    ['/app/panos/unused', '/app/panos/unused'],
    ['/app', '/app'],
  ])('%s -> %s', (path, redacted) => {
    expect(redactAdminPath(path)).toBe(redacted);
  });
});

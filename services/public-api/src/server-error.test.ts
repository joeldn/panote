import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import app from './index.js';

// Cloudflare counts a 500 the Worker answers as a success, so the operator event is the
// only count of it (worker-kit's recordServerErrors, registered first).
describe('server errors', () => {
  it('records a 500 by its route pattern', async () => {
    const events = { writeDataPoint: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bucket = { ...env.BUCKET, list: () => Promise.reject(new Error('R2 down')) };
    const r = await app.request('/api/explore', {}, { ...env, BUCKET: bucket, OPS_EVENTS: events });
    expect(r.status).toBe(500);
    expect(events.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: ['server-error', '500 GET /api/explore', 'public-api', 'o1'],
      }),
    );
  });
});

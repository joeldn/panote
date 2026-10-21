import { CLIENT_ID_PATTERN } from '@internal/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { clientId } from './identity.js';

afterEach(() => {
  localStorage.clear();
});

describe('clientId', () => {
  it('mints a v4 UUID once and keeps it', () => {
    const id = clientId();
    expect(id).toMatch(CLIENT_ID_PATTERN);
    expect(clientId()).toBe(id);
  });

  it('replaces a stored id public-api would refuse', () => {
    localStorage.setItem('panote_client_id', 'legacy-id');
    const id = clientId();
    expect(id).toMatch(CLIENT_ID_PATTERN);
    expect(localStorage.getItem('panote_client_id')).toBe(id);
  });
});

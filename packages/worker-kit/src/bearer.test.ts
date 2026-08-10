import { describe, expect, it } from 'vitest';

import { bearerToken } from './bearer.js';

const reqWithAuth = (value?: string): Request =>
  new Request(
    'https://example.com',
    value === undefined ? {} : { headers: { Authorization: value } },
  );

/**
 * A real fetch Request/Headers trims trailing whitespace off a header value
 * (per the Fetch spec), so `new Request(..., { headers: { Authorization:
 * 'Bearer ' } })` round-trips as `'Bearer'`, not `'Bearer '` - there is no way
 * to construct that exact input through a real Headers object. This stub
 * satisfies only the `req.headers.get(...)` shape bearerToken actually uses, so
 * the empty-token-after-strip case below tests bearerToken's own string logic
 * rather than the Fetch API's header-normalization behaviour.
 */
const reqWithRawAuth = (value: string | null): Request =>
  ({
    headers: { get: (name: string) => (name === 'Authorization' ? value : null) },
  }) as unknown as Request;

describe('bearerToken', () => {
  it('returns the token for Authorization: Bearer good', () => {
    expect(bearerToken(reqWithAuth('Bearer good'))).toBe('good');
  });

  it('returns null when the header is absent', () => {
    expect(bearerToken(reqWithAuth())).toBeNull();
  });

  it('returns null for Authorization: Bearer  (empty token after strip)', () => {
    expect(bearerToken(reqWithRawAuth('Bearer '))).toBeNull();
  });

  // Preserved quirks from crud-worker/src/index.ts:30 and upload-worker/src/index.ts:21
  // (see port spec section 2.4). A stricter parse is a deliberate future change,
  // not part of this port - these cases pin today's behaviour so that a later
  // tightening shows up as a visible test change.
  it('documents the preserved quirk: no space or a lowercase scheme is not stripped', () => {
    // 'Bearerfoo' (no space): the regex does not match, so the whole header
    // value is treated as the token. It then fails JWT parse and 401s, so the
    // outcome is right by accident.
    expect(bearerToken(reqWithAuth('Bearerfoo'))).toBe('Bearerfoo');
    // 'bearer x' (lowercase scheme): same story, same accidental correctness.
    expect(bearerToken(reqWithAuth('bearer x'))).toBe('bearer x');
  });
});

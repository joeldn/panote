import { describe, expect, it } from 'vitest';
import { containerEnvVars, type ContainerEnv } from './container-env.js';

/**
 * Covers the contract of `containerEnvVars` itself: which vars are forwarded,
 * which one is optional, and the fail-fast when any is missing.
 *
 * Does not cover the wiring that ships those vars (`Tiler`'s constructor) -
 * that's untestable here since `Container`'s constructor throws before it
 * runs, with no container runtime available. Verifying it needs a running
 * container image.
 */
describe('containerEnvVars', () => {
  it('forwards all four R2 credential vars verbatim', () => {
    const forwarded = containerEnvVars({
      R2_ACCOUNT_ID: 'account-1',
      R2_BUCKET: 'bucket-1',
      R2_ACCESS_KEY_ID: 'access-key-1',
      R2_SECRET_ACCESS_KEY: 'secret-key-1',
    });
    expect(forwarded['R2_ACCOUNT_ID']).toBe('account-1');
    expect(forwarded['R2_BUCKET']).toBe('bucket-1');
    expect(forwarded['R2_ACCESS_KEY_ID']).toBe('access-key-1');
    expect(forwarded['R2_SECRET_ACCESS_KEY']).toBe('secret-key-1');
  });

  it('forwards MAX_ORIGINAL_BYTES when present', () => {
    const forwarded = containerEnvVars({
      R2_ACCOUNT_ID: 'account-1',
      R2_BUCKET: 'bucket-1',
      R2_ACCESS_KEY_ID: 'access-key-1',
      R2_SECRET_ACCESS_KEY: 'secret-key-1',
      MAX_ORIGINAL_BYTES: '157286400',
    });
    expect(forwarded['MAX_ORIGINAL_BYTES']).toBe('157286400');
  });

  it('omits the MAX_ORIGINAL_BYTES key entirely when absent', () => {
    const forwarded = containerEnvVars({
      R2_ACCOUNT_ID: 'account-1',
      R2_BUCKET: 'bucket-1',
      R2_ACCESS_KEY_ID: 'access-key-1',
      R2_SECRET_ACCESS_KEY: 'secret-key-1',
    });
    expect('MAX_ORIGINAL_BYTES' in forwarded).toBe(false);
  });

  it('forwards no extra keys beyond the five documented ones', () => {
    const forwarded = containerEnvVars({
      R2_ACCOUNT_ID: 'account-1',
      R2_BUCKET: 'bucket-1',
      R2_ACCESS_KEY_ID: 'access-key-1',
      R2_SECRET_ACCESS_KEY: 'secret-key-1',
      MAX_ORIGINAL_BYTES: '157286400',
    });
    expect(Object.keys(forwarded).sort()).toEqual([
      'MAX_ORIGINAL_BYTES',
      'R2_ACCESS_KEY_ID',
      'R2_ACCOUNT_ID',
      'R2_BUCKET',
      'R2_SECRET_ACCESS_KEY',
    ]);
  });

  it('throws naming every missing var when all four are absent - exactly the situation that shipped', () => {
    // Models the shipped bug: no secrets configured means every field is
    // `undefined` at runtime despite the `string` type - `process.env.X`
    // (and, after this fix, the wrangler secret binding) is `undefined`
    // when unset, not an empty string.
    const noEnv = {} as ContainerEnv;
    expect(() => containerEnvVars(noEnv)).toThrowError(
      'tiler container env missing: R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY',
    );
  });

  it('throws naming only the missing vars when some are present', () => {
    const partialEnv = {
      R2_ACCOUNT_ID: 'account-1',
      R2_BUCKET: 'bucket-1',
    } as ContainerEnv;
    expect(() => containerEnvVars(partialEnv)).toThrowError(
      'tiler container env missing: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY',
    );
  });
});

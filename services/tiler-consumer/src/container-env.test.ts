import { describe, expect, it } from 'vitest';
import { containerEnvVars, type ContainerEnv } from './container-env.js';

/**
 * Covers the contract of `containerEnvVars` itself: which vars are forwarded,
 * which one is optional, and the fail-fast when any is missing. The bug this
 * package shipped was that nothing forwarded R2 credentials to the container
 * process, so it built its S3 client against
 * `https://undefined.r2.cloudflarestorage.com/undefined` and every tile job
 * 500s into the DLQ, silently.
 *
 * Be clear about what this file does NOT cover: the wiring that actually
 * ships those vars - `this.envVars = containerEnvVars(env)` in `Tiler`'s
 * constructor - is untested. It is also untestable from here: `Container`'s
 * constructor throws "Containers have not been enabled for this Durable
 * Object class" from `super(ctx, env)`, before that assignment ever runs,
 * whenever `ctx.container` is undefined - which is always, with no container
 * runtime available. Mutation-tested: deleting the assignment from
 * `consumer.ts` leaves every test in this package green. So this suite would
 * NOT on its own have caught the shipped bug, which was the missing wiring
 * and not a wrong helper. Verifying the wiring needs a running container
 * image.
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

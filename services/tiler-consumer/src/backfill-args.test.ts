import { describe, expect, it } from 'vitest';
import { panoIdsFromPrefixes, parseBackfillArgs } from './backfill-args.js';

const env = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'pano-content-dev',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('parseBackfillArgs', () => {
  it('defaults to a real run over every pano', () => {
    expect(parseBackfillArgs([], env)).toEqual({
      dryRun: false,
      panos: null,
      r2: {
        accountId: 'acct',
        bucket: 'pano-content-dev',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
      },
    });
  });

  it('takes --dry-run and repeated --pano', () => {
    const args = parseBackfillArgs(['--dry-run', '--pano', 'a', '--pano', 'b-2'], env);
    expect(args.dryRun).toBe(true);
    expect(args.panos).toEqual(['a', 'b-2']);
  });

  it.each(['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])(
    'requires %s',
    (name) => {
      expect(() => parseBackfillArgs(['--dry-run'], { ...env, [name]: '' })).toThrow(name);
    },
  );

  it('refuses a bucket that is not a -dev one unless it is named with --allow-bucket', () => {
    const prod = { ...env, R2_BUCKET: 'pano-content' };
    expect(() => parseBackfillArgs(['--dry-run'], prod)).toThrow(/--allow-bucket pano-content/);
    expect(() => parseBackfillArgs(['--allow-bucket', 'other'], prod)).toThrow(/allow-bucket/);
    expect(parseBackfillArgs(['--allow-bucket', 'pano-content'], prod).r2.bucket).toBe(
      'pano-content',
    );
  });

  it('rejects an unknown flag, a --pano with no value and a bad pano id', () => {
    expect(() => parseBackfillArgs(['--force'], env)).toThrow(/unknown argument --force/);
    expect(() => parseBackfillArgs(['--pano'], env)).toThrow(/--pano needs a value/);
    expect(() => parseBackfillArgs(['--pano', '../x'], env)).toThrow(/pano/);
  });
});

describe('panoIdsFromPrefixes', () => {
  it('turns tiles/<pano>/ prefixes into pano ids, dropping anything else', () => {
    expect(panoIdsFromPrefixes(['tiles/a/', 'tiles/b-2/', 'tiles/bad id/', 'other/c/'])).toEqual([
      'a',
      'b-2',
    ]);
  });
});

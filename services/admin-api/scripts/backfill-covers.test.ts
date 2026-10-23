import { describe, expect, it } from 'vitest';

import { parseBackfillArgs, runBackfill } from './backfill-covers-lib.ts';

const ENV = { R2_BUCKET: 'pano-content-dev', OPERATOR_TOKEN: 'test-operator-token' };

describe('parseBackfillArgs', () => {
  it('is a dry run unless --apply, ten tours a request', () => {
    expect(parseBackfillArgs([], ENV)).toEqual({
      apply: false,
      limit: 10,
      bucket: 'pano-content-dev',
      api: { origin: 'https://panote.dev', token: 'test-operator-token' },
    });
    expect(parseBackfillArgs(['--apply', '--limit', '25'], ENV)).toMatchObject({
      apply: true,
      limit: 25,
    });
  });

  it.each([
    [['--limit', '0'], /--limit must be/],
    [['--limit', '26'], /--limit must be/],
    [['--limit'], /needs a value/],
    [['--force'], /unknown argument/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseBackfillArgs(argv, ENV)).toThrow(error);
  });

  it('needs the bucket and the token, and a non-dev bucket named twice', () => {
    expect(() => parseBackfillArgs([], { OPERATOR_TOKEN: 'x' })).toThrow(/R2_BUCKET/);
    expect(() => parseBackfillArgs([], { R2_BUCKET: 'pano-content-dev' })).toThrow(
      /OPERATOR_TOKEN/,
    );
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    expect(() => parseBackfillArgs([], prod)).toThrow(/--allow-bucket/);
    expect(parseBackfillArgs(['--allow-bucket', 'pano-content'], prod)).toMatchObject({
      api: { origin: 'https://panote.io' },
    });
  });
});

describe('runBackfill', () => {
  it('counts the other changes of a tour whose cover was skipped', async () => {
    const page = {
      tours: [
        { tourId: 'a', changes: ['owner-pointer'], skipped: 'tour.json changed since read' },
        { tourId: 'b', changes: ['cover'] },
      ],
      cursor: null,
    };
    const lines: string[] = [];
    const code = await runBackfill(
      {
        apply: true,
        limit: 10,
        bucket: 'pano-content-dev',
        api: { origin: 'https://panote.dev', token: 't' },
      },
      { fetch: async () => Response.json(page), log: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(lines).toContain('skip a: tour.json changed since read');
    expect(lines).toContain('update a: owner-pointer');
    expect(lines.at(-1)).toMatch(
      /^2 tour\(s\): 2 updated \(cover 1, owner pointer 1, Explore 0\), 1 skipped/,
    );
  });
});

import { describe, expect, it } from 'vitest';

import { parseRestoreArgs } from './restore-backup-lib.ts';

const ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'pano-content-dev',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  OPERATOR_TOKEN: 'test-operator-token',
};
const SUB = 'google-oauth2|restore-1';
const DATE = '2026-10-22';

describe('parseRestoreArgs', () => {
  it('is a dry run unless --apply, and needs the operator token only then', () => {
    expect(parseRestoreArgs(['--date', DATE, '--tour', 't1'], ENV)).toMatchObject({
      mode: 'restore',
      scope: { kind: 'tour', tourId: 't1', sub: undefined },
      apply: false,
      overwrite: false,
      api: undefined,
    });
    const { OPERATOR_TOKEN: _, ...noToken } = ENV;
    expect(parseRestoreArgs(['--date', DATE, '--all'], noToken)).toMatchObject({
      scope: { kind: 'all' },
    });
    expect(() => parseRestoreArgs(['--date', DATE, '--all', '--apply'], noToken)).toThrow(
      /OPERATOR_TOKEN/,
    );
    expect(parseRestoreArgs(['--date', DATE, '--sub', SUB, '--apply'], ENV)).toMatchObject({
      scope: { kind: 'owner', sub: SUB },
      api: { origin: 'https://panote.dev', token: 'test-operator-token' },
    });
    expect(parseRestoreArgs(['--list'], ENV)).toMatchObject({ mode: 'list' });
  });

  it.each([
    [[], /--date is required/],
    [['--date', '2026-10-22/..', '--all'], /YYYY-MM-DD/],
    [['--date', DATE], /--tour, --sub or --all/],
    [['--date', DATE, '--tour', 't1', '--all'], /exclusive/],
    [['--date', DATE, '--sub', SUB, '--all'], /exclusive/],
    [['--date', DATE, '--tour', 'a/b'], /--tour must match/],
    [['--date', DATE, '--sub', ` ${SUB}`], /whitespace/],
    [['--list', '--date', DATE], /--list takes no other/],
    [['--date', DATE, '--all', '--force'], /unknown argument/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseRestoreArgs(argv, ENV)).toThrow(error);
  });

  it('lists and restores the trash by pano or owner', () => {
    expect(parseRestoreArgs(['--list-trash'], ENV)).toEqual(
      expect.objectContaining({ mode: 'trash-list', sub: undefined }),
    );
    expect(parseRestoreArgs(['--list-trash', '--sub', SUB], ENV)).toMatchObject({ sub: SUB });
    expect(
      parseRestoreArgs(['--from-trash', '--pano', 'p1', '--pano', 'p2', '--pano', 'p1'], ENV),
    ).toMatchObject({
      mode: 'trash-restore',
      panos: ['p1', 'p2'],
      sub: undefined,
      date: undefined,
      apply: false,
      api: undefined,
    });
    expect(
      parseRestoreArgs(['--from-trash', '--sub', SUB, '--date', DATE, '--apply'], ENV),
    ).toMatchObject({
      panos: [],
      sub: SUB,
      date: DATE,
      apply: true,
      api: { token: 'test-operator-token' },
    });
  });

  it.each([
    [['--from-trash'], /--pano, or --sub/],
    [['--from-trash', '--tour', 't1'], /not --tour or --all/],
    [['--from-trash', '--all'], /not --tour or --all/],
    [['--from-trash', '--pano', 'a/b'], /--pano must match/],
    [['--from-trash', '--pano', 'p1', '--date', 'x'], /YYYY-MM-DD/],
    [['--list-trash', '--from-trash'], /exclusive/],
    [['--list-trash', '--apply'], /takes only --sub/],
    [['--date', DATE, '--all', '--pano', 'p1'], /only goes with --from-trash/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseRestoreArgs(argv, ENV)).toThrow(error);
  });

  it('makes a non-dev bucket be named twice', () => {
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    expect(() => parseRestoreArgs(['--date', DATE, '--all'], prod)).toThrow(/--allow-bucket/);
    expect(
      parseRestoreArgs(
        ['--date', DATE, '--all', '--allow-bucket', 'pano-content', '--apply'],
        prod,
      ),
    ).toMatchObject({ api: { origin: 'https://panote.io' } });
  });
});

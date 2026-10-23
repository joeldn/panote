import { describe, expect, it } from 'vitest';

import { readSettings } from './settings.js';
import { mapConfig, stackSettings } from './test-support.js';

const DEV = {
  accountId: '12e2809e05de8a2bf20b815fd394ec9a',
  zone: 'panote.dev',
  bucket: 'pano-content-dev',
  uploadsQueue: 'pano-uploads-dev',
  deadLetterQueue: 'pano-uploads-dlq-dev',
  corsFile: 'cors.json',
  cacheRulesFile: 'cache-rules.dev.json',
};
const PRODUCTION = {
  ...DEV,
  zone: 'panote.io',
  bucket: 'pano-content',
  uploadsQueue: 'pano-uploads',
  deadLetterQueue: 'pano-uploads-dlq',
  cacheRulesFile: 'cache-rules.production.json',
};

describe('readSettings', () => {
  it('reads the committed stack files', () => {
    expect(stackSettings('dev')).toMatchObject({ ...DEV, noindexAllResponses: true });
    expect(stackSettings('production')).toMatchObject({
      ...PRODUCTION,
      noindexAllResponses: false,
      wwwRedirect: true,
    });
  });

  it('defaults the flags to off', () => {
    expect(readSettings('dev', mapConfig(DEV))).toMatchObject({
      noindexAllResponses: false,
      wwwRedirect: false,
    });
  });

  it.each([
    ['an unknown stack', 'staging', DEV, /unknown stack/],
    ['a missing key', 'dev', { ...DEV, bucket: undefined }, /bucket/],
    ['a bad account id', 'dev', { ...DEV, accountId: 'YOUR_ACCOUNT' }, /accountId/],
    ['a bad zone', 'dev', { ...DEV, zone: 'panote' }, /zone/],
    ['a bad name', 'dev', { ...DEV, bucket: 'Pano_Content-dev' }, /not a resource name/],
    ['a prod name on dev', 'dev', { ...DEV, uploadsQueue: 'pano-uploads' }, /must end in -dev/],
    [
      'a dev name on production',
      'production',
      { ...PRODUCTION, bucket: 'pano-content-dev' },
      /dev name/,
    ],
    ['a path as a file', 'dev', { ...DEV, corsFile: '../cors.json' }, /JSON file name/],
    [
      'cors.dev.json on production',
      'production',
      { ...PRODUCTION, corsFile: 'cors.dev.json' },
      /cors\.json/,
    ],
    [
      'noindex on production',
      'production',
      { ...PRODUCTION, noindexAllResponses: 'true' },
      /search engines/,
    ],
  ])('refuses %s', (_, stack, values, error) => {
    const defined = Object.fromEntries(
      Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    expect(() => readSettings(stack, mapConfig(defined))).toThrow(error);
  });
});

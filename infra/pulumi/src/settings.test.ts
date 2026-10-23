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
  bucketLocation: 'enam',
  uploadsQueue: 'pano-uploads',
  deadLetterQueue: 'pano-uploads-dlq',
  cacheRulesFile: 'cache-rules.production.json',
};

const DEV_GITHUB = {
  ...DEV,
  'github:owner': 'joeldn',
  githubRepository: 'panote',
  githubRepositoryWide: 'true',
  githubInfraPreviewReviewer: 'joeldn',
};
const PRODUCTION_GITHUB = {
  ...PRODUCTION,
  'github:owner': 'joeldn',
  githubRepository: 'panote',
  githubEnvironmentReviewer: 'joeldn',
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

  it('leaves dev on its existing bucket location', () => {
    expect(stackSettings('dev').bucketLocation).toBeUndefined();
  });

  it('declares no Auth0 until the stack names its tenant', () => {
    expect(
      readSettings('dev', mapConfig({ ...DEV, auth0LocalDevCallbacks: 'true' })).auth0,
    ).toBeUndefined();
    expect(
      readSettings(
        'dev',
        mapConfig({
          ...DEV,
          auth0LocalDevCallbacks: 'true',
          'auth0:domain': 'panote-dev.auth0.com',
        }),
      ).auth0,
    ).toEqual({ domain: 'panote-dev.auth0.com', localDevCallbacks: true });
  });

  it('reads an Auth0 tenant and its Google client', () => {
    expect(
      readSettings(
        'production',
        mapConfig({
          ...PRODUCTION,
          'auth0:domain': 'panote.us.auth0.com',
          googleClientId: '1234-abc.apps.googleusercontent.com',
        }),
      ).auth0,
    ).toEqual({
      domain: 'panote.us.auth0.com',
      googleClientId: '1234-abc.apps.googleusercontent.com',
      localDevCallbacks: false,
    });
    expect(
      readSettings('dev', mapConfig({ ...DEV, 'auth0:domain': 'panote-dev.auth0.com' })).auth0,
    ).toEqual({ domain: 'panote-dev.auth0.com', localDevCallbacks: false });
  });

  it('declares nothing on GitHub until the stack names the owner', () => {
    const { 'github:owner': _, ...unnamed } = DEV_GITHUB;
    expect(readSettings('dev', mapConfig(unnamed)).github).toBeUndefined();
  });

  it('reads the GitHub repository and who owns what of it', () => {
    expect(readSettings('dev', mapConfig({ ...DEV_GITHUB, devAutoDeploy: 'true' })).github).toEqual(
      {
        owner: 'joeldn',
        repository: 'panote',
        repositoryWide: { infraPreviewReviewer: 'joeldn', devAutoDeploy: true },
      },
    );
    // DEV_AUTO_DEPLOY defaults to off.
    expect(readSettings('dev', mapConfig(DEV_GITHUB)).github?.repositoryWide?.devAutoDeploy).toBe(
      false,
    );
    expect(readSettings('production', mapConfig(PRODUCTION_GITHUB)).github).toEqual({
      owner: 'joeldn',
      repository: 'panote',
      environmentReviewer: 'joeldn',
    });
  });

  it.each([
    ['a bad GitHub owner', 'dev', { ...DEV_GITHUB, 'github:owner': '-joel' }, /not a GitHub login/],
    [
      'a bad reviewer',
      'dev',
      { ...DEV_GITHUB, githubInfraPreviewReviewer: 'joel dn' },
      /not a GitHub login/,
    ],
    [
      'a bad repository',
      'dev',
      { ...DEV_GITHUB, githubRepository: 'joeldn/panote' },
      /not a repository name/,
    ],
    ['no repository', 'dev', { ...DEV_GITHUB, githubRepository: undefined }, /githubRepository/],
    [
      'production without its reviewer',
      'production',
      { ...PRODUCTION_GITHUB, githubEnvironmentReviewer: undefined },
      /needs githubEnvironmentReviewer/,
    ],
    [
      'a reviewer on dev',
      'dev',
      { ...DEV_GITHUB, githubEnvironmentReviewer: 'joeldn' },
      /hold every automatic deploy/,
    ],
    [
      'repository-wide settings without a preview reviewer',
      'dev',
      { ...DEV_GITHUB, githubInfraPreviewReviewer: undefined },
      /needs githubInfraPreviewReviewer/,
    ],
    [
      'devAutoDeploy on a stack without the repository-wide settings',
      'production',
      { ...PRODUCTION_GITHUB, devAutoDeploy: 'true' },
      /only apply with githubRepositoryWide/,
    ],

    ['an unknown stack', 'staging', DEV, /unknown stack/],
    [
      'a custom domain as the tenant',
      'dev',
      { ...DEV, 'auth0:domain': 'login.panote.dev' },
      /tenant domain/,
    ],
    [
      'the placeholder tenant',
      'dev',
      { ...DEV, 'auth0:domain': 'YOUR_PROD_TENANT.auth0.com' },
      /tenant domain/,
    ],
    [
      'a production tenant on dev',
      'dev',
      { ...DEV, 'auth0:domain': 'panote.auth0.com' },
      /-dev tenant/,
    ],
    [
      'the dev tenant on production',
      'production',
      { ...PRODUCTION, 'auth0:domain': 'panote-dev.au.auth0.com' },
      /dev tenant/,
    ],
    [
      "Auth0's developer keys on production",
      'production',
      { ...PRODUCTION, 'auth0:domain': 'panote.auth0.com' },
      /own Google OAuth client/,
    ],
    [
      'a bad Google client id',
      'dev',
      { ...DEV, 'auth0:domain': 'panote-dev.auth0.com', googleClientId: 'GOCSPX-x' },
      /googleClientId/,
    ],
    [
      'localhost callbacks on production',
      'production',
      {
        ...PRODUCTION,
        'auth0:domain': 'panote.auth0.com',
        googleClientId: '1-a.apps.googleusercontent.com',
        auth0LocalDevCallbacks: 'true',
      },
      /localhost/,
    ],
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
    [
      'production without a bucket location',
      'production',
      { ...PRODUCTION, bucketLocation: undefined },
      /needs a bucketLocation/,
    ],
    ['an unknown location', 'dev', { ...DEV, bucketLocation: 'eu' }, /not one of/],
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

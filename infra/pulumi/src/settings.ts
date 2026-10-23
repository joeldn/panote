/**
 * Per-stack settings, read from `Pulumi.<stack>.yaml` (namespace
 * `panote-infra`). Everything that differs between dev and production is here;
 * the program itself has no `if (stack === 'dev')`.
 */
export interface Settings {
  /** `dev` or `production`; the stack name. */
  readonly stack: 'dev' | 'production';
  readonly accountId: string;
  /** The zone the site and its CDN live on: `panote.dev` / `panote.io`. */
  readonly zone: string;
  readonly bucket: string;
  /**
   * The R2 location hint the bucket is created with. Cloudflare only reads it
   * when the bucket is first created and never moves a bucket afterwards.
   * Production requires one, so the bucket doesn't end up near whoever happens
   * to run `pulumi up`. Dev's bucket already exists, so it has none.
   */
  readonly bucketLocation?: BucketLocation | undefined;
  readonly uploadsQueue: string;
  readonly deadLetterQueue: string;
  /** File name under `infra/r2/`. */
  readonly corsFile: string;
  /** File name under `infra/cloudflare/`. */
  readonly cacheRulesFile: string;
  /** Dev only: `X-Robots-Tag: noindex, nofollow` on every response of the zone. */
  readonly noindexAllResponses: boolean;
  /** Production only: `www.<zone>` redirects to the apex. */
  readonly wwwRedirect: boolean;
  /**
   * The stack's Auth0 tenant (src/auth0.ts). Absent until the stack names a
   * tenant (`auth0:domain`, the provider's own key, so the provider and the
   * program can never point at two different tenants). Until then nothing in
   * Auth0 is declared: dev's is named when it is imported, production's once
   * it exists (infra/README.md, steps 13 and 16).
   */
  readonly auth0?: Auth0Settings;
  /**
   * The GitHub repository (src/github.ts). Absent until the stack names its
   * owner (`github:owner`, the provider's own key), so nothing on GitHub is
   * declared before the import (infra/README.md, step 19).
   */
  readonly github?: GithubSettings;
}

export interface GithubSettings {
  /** The account that owns the repository: `joeldn`. */
  readonly owner: string;
  /** The repository's name: `panote`. */
  readonly repository: string;
  /**
   * The one person who approves this stack's GitHub Environment (production).
   * Dev has none: a reviewer would hold every automatic deploy.
   */
  readonly environmentReviewer?: string;
  /**
   * Set on exactly one stack (dev): the settings there is one of per
   * repository, so two stacks never fight over them (docs/decisions.md).
   */
  readonly repositoryWide?: GithubRepositoryWideSettings;
}

export interface GithubRepositoryWideSettings {
  /** Who approves an `infra-preview` run, which holds the stacks' passphrase. */
  readonly infraPreviewReviewer: string;
  /** The `DEV_AUTO_DEPLOY` repository variable (docs/deploy.md, GitHub setup). */
  readonly devAutoDeploy: boolean;
}

export interface Auth0Settings {
  /** The tenant's own domain, e.g. `panote-dev.au.auth0.com`; never a custom domain. */
  readonly domain: string;
  /**
   * The Google OAuth client the `google-oauth2` connection uses (its secret is
   * the `googleClientSecret` secret). Unset: Auth0's developer keys, which
   * production refuses.
   */
  readonly googleClientId?: string;
  /** Dev only: the SPA also allows the local Vite servers (docs/deploy.md, Local dev). */
  readonly localDevCallbacks: boolean;
}

/** R2's location hints: best effort, not a guarantee (unlike a jurisdiction). */
export const BUCKET_LOCATIONS = ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'] as const;
export type BucketLocation = (typeof BUCKET_LOCATIONS)[number];

/** The subset of `pulumi.Config` this module needs, so tests can pass a map. */
export interface ConfigSource {
  get(key: string): string | undefined;
  require(key: string): string;
  getBoolean(key: string): boolean | undefined;
}

/** The key `ConfigSource.get` answers with the provider's `auth0:domain`. */
export const AUTH0_DOMAIN_KEY = 'auth0:domain';

/** The key `ConfigSource.get` answers with the provider's `github:owner`. */
export const GITHUB_OWNER_KEY = 'github:owner';

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const ZONE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FILE_NAME = /^[A-Za-z0-9._-]+\.json$/;
/** A tenant's own domain: `<name>.auth0.com` or `<name>.<region>.auth0.com`. */
const AUTH0_DOMAIN = /^[a-z0-9-]+(\.[a-z]{2})?\.auth0\.com$/;
/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GOOGLE_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/**
 * Reads and checks the stack's settings. Dev resources carry the `-dev`
 * suffix and production's never do (docs/STANDARDS.md), so a production stack
 * pointed at a dev name, or the other way round, fails here before anything
 * reaches Cloudflare.
 */
export function readSettings(stack: string, config: ConfigSource): Settings {
  if (stack !== 'dev' && stack !== 'production') {
    throw new Error(`unknown stack "${stack}": expected dev or production`);
  }
  const accountId = config.require('accountId');
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`accountId "${accountId}" is not an account id`);
  const zone = config.require('zone');
  if (!ZONE.test(zone)) throw new Error(`zone "${zone}" is not a zone name`);

  const names = {
    bucket: config.require('bucket'),
    uploadsQueue: config.require('uploadsQueue'),
    deadLetterQueue: config.require('deadLetterQueue'),
  };
  for (const [key, name] of Object.entries(names)) {
    if (!RESOURCE_NAME.test(name)) throw new Error(`${key} "${name}" is not a resource name`);
    const isDevName = name.endsWith('-dev');
    if (stack === 'dev' && !isDevName) throw new Error(`${key} "${name}" must end in -dev on dev`);
    if (stack === 'production' && isDevName) {
      throw new Error(`${key} "${name}" is a dev name; production must not use it`);
    }
  }

  const bucketLocation = config.get('bucketLocation');
  if (bucketLocation !== undefined && !isBucketLocation(bucketLocation)) {
    throw new Error(
      `bucketLocation "${bucketLocation}" is not one of ${BUCKET_LOCATIONS.join(', ')}`,
    );
  }
  if (stack === 'production' && bucketLocation === undefined) {
    throw new Error('production needs a bucketLocation: R2 never moves a bucket once created');
  }

  const corsFile = config.require('corsFile');
  const cacheRulesFile = config.require('cacheRulesFile');
  for (const [key, file] of Object.entries({ corsFile, cacheRulesFile })) {
    if (!FILE_NAME.test(file)) throw new Error(`${key} "${file}" is not a JSON file name`);
  }
  if (stack === 'production' && corsFile !== 'cors.json') {
    throw new Error(`production must use cors.json, not ${corsFile}`);
  }

  const noindexAllResponses = config.getBoolean('noindexAllResponses') ?? false;
  if (stack === 'production' && noindexAllResponses) {
    throw new Error('noindexAllResponses would hide production from search engines');
  }

  const auth0 = readAuth0Settings(stack, config);
  const github = readGithubSettings(stack, config);
  return {
    stack,
    accountId,
    zone,
    ...names,
    bucketLocation,
    corsFile,
    cacheRulesFile,
    noindexAllResponses,
    wwwRedirect: config.getBoolean('wwwRedirect') ?? false,
    ...(auth0 ? { auth0 } : {}),
    ...(github ? { github } : {}),
  };
}

function isBucketLocation(value: string): value is BucketLocation {
  return (BUCKET_LOCATIONS as readonly string[]).includes(value);
}

/**
 * The Auth0 half, the same way: a dev tenant's name ends in `-dev` and
 * production's never does, so a stack pointed at the other environment's
 * tenant fails here, before any call to it.
 */
function readAuth0Settings(stack: Settings['stack'], config: ConfigSource) {
  const domain = config.get(AUTH0_DOMAIN_KEY);
  const googleClientId = config.get('googleClientId');
  const localDevCallbacks = config.getBoolean('auth0LocalDevCallbacks') ?? false;
  // The other keys may sit in the stack file before the tenant is named.
  if (domain === undefined) return undefined;
  if (!AUTH0_DOMAIN.test(domain)) {
    throw new Error(`${AUTH0_DOMAIN_KEY} "${domain}" is not an Auth0 tenant domain`);
  }
  const isDevTenant = domain.split('.')[0]?.endsWith('-dev') ?? false;
  if (stack === 'dev' && !isDevTenant) {
    throw new Error(`${AUTH0_DOMAIN_KEY} "${domain}" must be a -dev tenant on dev`);
  }
  if (stack === 'production' && isDevTenant) {
    throw new Error(`${AUTH0_DOMAIN_KEY} "${domain}" is a dev tenant; production must not use it`);
  }
  if (googleClientId !== undefined && !GOOGLE_CLIENT_ID.test(googleClientId)) {
    throw new Error(`googleClientId "${googleClientId}" is not a Google OAuth client id`);
  }
  if (stack === 'production' && googleClientId === undefined) {
    throw new Error(
      "production needs its own Google OAuth client (googleClientId), not Auth0's developer keys",
    );
  }
  if (stack === 'production' && localDevCallbacks) {
    throw new Error('auth0LocalDevCallbacks would let localhost receive production sign-ins');
  }
  return {
    domain,
    ...(googleClientId === undefined ? {} : { googleClientId }),
    localDevCallbacks,
  } satisfies Auth0Settings;
}

/**
 * The GitHub half. Production's Environment must have its reviewer (the
 * approval deploy.yml relies on) and dev's must not (it would hold every
 * automatic deploy).
 */
function readGithubSettings(stack: Settings['stack'], config: ConfigSource) {
  const owner = config.get(GITHUB_OWNER_KEY);
  const environmentReviewer = config.get('githubEnvironmentReviewer');
  const repositoryWide = config.getBoolean('githubRepositoryWide') ?? false;
  const infraPreviewReviewer = config.get('githubInfraPreviewReviewer');
  const devAutoDeploy = config.getBoolean('devAutoDeploy');
  // Like Auth0's, the other keys may sit in the stack file before the owner is named.
  if (owner === undefined) return undefined;
  const repository = config.require('githubRepository');
  for (const [key, login] of Object.entries({
    [GITHUB_OWNER_KEY]: owner,
    githubEnvironmentReviewer: environmentReviewer,
    githubInfraPreviewReviewer: infraPreviewReviewer,
  })) {
    if (login !== undefined && !GITHUB_LOGIN.test(login)) {
      throw new Error(`${key} "${login}" is not a GitHub login`);
    }
  }
  if (!GITHUB_REPOSITORY.test(repository)) {
    throw new Error(`githubRepository "${repository}" is not a repository name`);
  }
  if (stack === 'production' && environmentReviewer === undefined) {
    throw new Error('production needs githubEnvironmentReviewer: deploys to it wait for approval');
  }
  if (stack === 'dev' && environmentReviewer !== undefined) {
    throw new Error('githubEnvironmentReviewer on dev would hold every automatic deploy');
  }
  if (!repositoryWide && (infraPreviewReviewer !== undefined || devAutoDeploy !== undefined)) {
    throw new Error(
      'githubInfraPreviewReviewer and devAutoDeploy only apply with githubRepositoryWide',
    );
  }
  if (repositoryWide && infraPreviewReviewer === undefined) {
    throw new Error(
      'githubRepositoryWide needs githubInfraPreviewReviewer: infra-preview runs hold the passphrase',
    );
  }
  return {
    owner,
    repository,
    ...(environmentReviewer === undefined ? {} : { environmentReviewer }),
    ...(repositoryWide && infraPreviewReviewer !== undefined
      ? { repositoryWide: { infraPreviewReviewer, devAutoDeploy: devAutoDeploy ?? false } }
      : {}),
  } satisfies GithubSettings;
}
